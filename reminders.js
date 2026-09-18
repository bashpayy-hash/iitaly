'use strict';

const { createHash } = require('node:crypto');
const RETRY_MS = 15 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const CHANNELS = ['telegram', 'email', 'owner'];
const MARKS = [1, 3, 7];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const copy = value => JSON.parse(JSON.stringify(value));
const targetKey = value => createHash('sha256').update(String(value)).digest('hex');
const eventKey = (task, mark) => JSON.stringify([task.id, task.deadline, mark]);
function dayKey(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function weekKey(date) {
  const monday = new Date(date);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return dayKey(monday);
}
function tasksFor(roadmap, client) {
  return roadmap.flatMap(stage => stage.tasks || []).filter(task =>
    typeof task.id === 'string' && typeof task.t === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(task.deadline) && Number.isFinite(task.daysLeft) &&
    !(client.done && client.done[task.id]));
}

// Legacy marks recorded success for *any* recipient. They cannot prove delivery
// to a student. Keep them separately as replay suppression, never as receipts.
function initialLedger(client, roadmap, now) {
  if (client.reminderDelivery != null) {
    const old = client.reminderDelivery;
    if (!plain(old) || old.version !== 1 || !plain(old.channels) || !plain(old.legacySuppressed)) {
      throw new Error('Invalid reminder ledger; refusing to reset delivery history');
    }
    return copy(old);
  }
  const legacySuppressed = {};
  const legacy = plain(client.reminded) ? client.reminded : {};
  for (const task of roadmap.flatMap(stage => stage.tasks || [])) {
    if (!task.deadline) continue;
    for (const mark of [...MARKS, 'over']) {
      if (legacy[`${task.id}:${mark}`]) legacySuppressed[eventKey(task, mark)] = true;
    }
  }
  // Preserve only this week's old digest; future weeks are separate events.
  const monday = weekKey(now);
  const digest = JSON.stringify(['digest', client.intakeYear || '', monday]);
  if (legacy[`digest:${monday}`]) legacySuppressed[digest] = true;
  return { version: 1, createdAt: now.toISOString(), legacySuppressed, channels: {} };
}

function makeBatch(client, roadmap, ledger, state, now) {
  const outstanding = tasksFor(roadmap, client);
  const already = key => has(state.sent, key) || has(ledger.legacySuppressed, key);
  const urgent = outstanding.map(task => {
    // One current urgency band, not 7 -> 3 -> 1 on successive retry ticks.
    const mark = task.daysLeft < 0 ? 'over' : MARKS.find(days => task.daysLeft <= days);
    return mark === undefined ? null : { task, key: eventKey(task, mark) };
  }).filter(item => item && !already(item.key)).slice(0, 6);
  const monday = weekKey(now);
  const digestKey = JSON.stringify(['digest', client.intakeYear || '', monday]);
  const digestDue = (now.getDay() === 1 || state.pendingDigest === digestKey) && !already(digestKey);
  const digest = digestDue ? outstanding.filter(t => t.daysLeft > 7 && t.daysLeft <= 45)
    .sort((a, b) => a.daysLeft - b.daysLeft) : [];
  // Bound provider message length even if a future roadmap has very long titles.
  const title = task => Array.from(task.t).slice(0, 120).join('');
  const lines = urgent.map(({ task }) => (task.daysLeft < 0
    ? `⚠ просрочено на ${-task.daysLeft} дн` : `⏰ через ${task.daysLeft} дн`) + ` — ${title(task)}`);
  if (digest.length) {
    if (lines.length) lines.push('');
    lines.push('Ближайшие полтора месяца:');
    lines.push(...digest.slice(0, 5).map(t => `• через ${t.daysLeft} дн — ${title(t)}`));
    if (digest.length > 5) lines.push(`… и ещё ${digest.length - 5} шагов в кабинете`);
  }
  return {
    lines,
    // Only the urgent tasks actually included in this message are acknowledged.
    keys: [...urgent.map(item => item.key), ...(digest.length ? [digestKey] : [])],
    pendingDigest: digest.length ? digestKey : null,
    overdue: urgent.some(item => item.task.daysLeft < 0),
  };
}

/** A single-process runner. Storage callbacks must be synchronous, as the
 * existing encrypted file store is. No customer data is read during tests:
 * clock, store, roadmap and transports are all injectable. */
function createReminderRunner({ listCodes, readClient, writeClient, buildRoadmap,
  channelsFor, now = () => new Date(), siteUrl = 'https://iitaly.netlify.app',
  logger = console }) {
  let running = null;
  let telegramNotBefore = 0;
  // Keep acknowledged sends in memory if the disk write fails, and retry the
  // write BEFORE attempting any more sends. This is not a distributed outbox.
  const dirty = new Map();
  let portalUrl = 'https://iitaly.netlify.app/portal';
  try {
    const url = new URL('/portal', siteUrl);
    if (['https:', 'http:'].includes(url.protocol)) portalUrl = url.href;
  } catch { /* A bad optional SITE_URL must not prevent the server booting. */ }
  function persist(code, identity, ledger) {
    const fresh = readClient(code);
    if (!fresh || fresh.createdAt !== identity) { dirty.delete(code); return false; }
    // Re-read after awaits: do not overwrite /stop, notify settings, completed
    // tasks, uploaded documents, or recreate a client deleted during a send.
    fresh.reminderDelivery = ledger;
    if (!writeClient(code, fresh)) { dirty.set(code, { identity, ledger: copy(ledger) }); return false; }
    dirty.delete(code);
    return true;
  }
  async function run() {
    const stats = { checked: 0, sent: 0, accepted: 0, failed: 0, storageErrors: 0 };
    const codes = listCodes();
    for (const code of dirty.keys()) if (!codes.includes(code)) dirty.delete(code);
    for (const code of codes) {
      let counted = false;
      try {
        let client = readClient(code);
        if (!client) continue;
        stats.checked++;
        const buffered = dirty.get(code);
        if (buffered && !persist(code, buffered.identity, buffered.ledger)) {
          stats.storageErrors++; continue;
        }
        client = readClient(code);
        if (!client) continue;
        const identity = client.createdAt;
        let ledger = initialLedger(client, buildRoadmap(client), now());
        if (!client.reminderDelivery && !persist(code, identity, ledger)) {
          stats.storageErrors++; continue;
        }
        for (const channel of CHANNELS) {
          client = readClient(code);
          if (!client || client.createdAt !== identity) break;
          const descriptor = channelsFor(client)[channel];
          if (!descriptor || !descriptor.enabled || !descriptor.target) continue;
          const fingerprint = targetKey(descriptor.target);
          let state = ledger.channels[channel];
          if (!state || state.target !== fingerprint) {
            state = { target: fingerprint, sent: {}, failures: 0, notBefore: 0, pendingDigest: null };
          }
          if (!plain(state.sent)) throw new Error('Invalid channel receipts');
          const time = now();
          if (Number(state.notBefore) > time.getTime() ||
              (descriptor.transport === 'telegram' && telegramNotBefore > time.getTime())) continue;
          const batch = makeBatch(client, buildRoadmap(client), ledger, state, time);
          if (!batch.keys.length) {
            if (state.failures || state.pendingDigest) {
              ledger.channels[channel] = { ...state, failures: 0, notBefore: 0, pendingDigest: null };
              if (!persist(code, identity, ledger)) { stats.storageErrors++; break; }
            }
            continue;
          }
          const clientText = `Привет, ${client.name}! Напоминание по твоему поступлению:\n\n` +
            batch.lines.join('\n') + `\n\nОткрыть кабинет: ${portalUrl}`;
          const text = channel === 'owner'
            ? `Напоминание по клиенту\n${client.surname} ${client.name} · код ${code}\n\n${batch.lines.join('\n')}`
            : clientText + (channel === 'email'
              ? '\n\nОтключить письма: кабинет → Помощь → Напоминания.'
              : '\n\nОтключить напоминания: /stop');
          let result;
          try {
            result = await descriptor.send(text, batch.overdue
              ? 'IItaly: есть просроченные шаги' : 'IItaly: скоро дедлайн по поступлению');
          } catch { result = { ok: false }; }
          const finished = now();
          state = copy(state);
          if (result && result.ok === true) {
            for (const key of batch.keys) state.sent[key] = finished.toISOString();
            state.failures = 0; state.notBefore = 0; state.pendingDigest = null;
            stats.accepted++;
            if (!counted) { stats.sent++; counted = true; }
          } else {
            state.failures = Math.min((state.failures || 0) + 1, 16);
            const retryAfter = Number(result && result.retryAfterMs);
            const delay = Math.max(Math.min(RETRY_MS * 2 ** (state.failures - 1), MAX_RETRY_MS),
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0);
            state.notBefore = finished.getTime() + delay;
            state.pendingDigest = batch.pendingDigest;
            if (result && result.rateLimited && descriptor.transport === 'telegram') {
              telegramNotBefore = Math.max(telegramNotBefore, state.notBefore);
            }
            stats.failed++;
          }
          ledger.channels[channel] = state;
          if (!persist(code, identity, ledger)) { stats.storageErrors++; break; }
        }
      } catch {
        // Never log token-bearing URLs, exception text or customer information.
        stats.failed++;
        logger.warn('REMINDERS: client processing failed; will retry on a later tick');
      }
    }
    logger.log(`REMINDERS: checked ${stats.checked}, accepted ${stats.accepted}, failed ${stats.failed}, storage errors ${stats.storageErrors}`);
    return stats;
  }
  return function runReminders() {
    // Timer/manual calls share one job; they cannot send the same item twice.
    if (!running) running = run().finally(() => { running = null; });
    return running;
  };
}

module.exports = { createReminderRunner, RETRY_MS, MAX_RETRY_MS };
