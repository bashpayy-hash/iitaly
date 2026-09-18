'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReminderRunner, RETRY_MS, MAX_RETRY_MS } = require('../reminders');
const { sendTelegramReminder } = require('../reminder-telegram');
const clone = value => JSON.parse(JSON.stringify(value));
const task = (id = 'apply', daysLeft = 7, deadline = '2026-09-25') => ({ id, t: `Задача ${id}`, daysLeft, deadline });
function harness({ client = {}, tasks = [task()], handlers = {} } = {}) {
  const seed = { code: 'TEST-001', name: 'Тест', surname: 'Пример', createdAt: '2026-01-01',
    intakeYear: 2026, tgChatId: 100, email: 'student@example.invalid',
    notify: { telegram: true, email: true }, done: {}, ...client };
  const store = new Map([[seed.code, clone(seed)]]);
  let time = new Date('2026-09-18T09:00:00');
  const calls = []; const logs = [];
  const h = { store, tasks, calls, handlers, failWrite: false };
  h.current = () => store.get(seed.code);
  h.advance = ms => { time = new Date(time.getTime() + ms); };
  h.setTime = text => { time = new Date(text); };
  h.makeRunner = () => createReminderRunner({
    listCodes: () => [...store.keys()], readClient: code => store.has(code) ? clone(store.get(code)) : null,
    writeClient: (code, value) => { if (h.failWrite) return false; store.set(code, clone(value)); return true; },
    buildRoadmap: () => [{ tasks: h.tasks }], now: () => new Date(time),
    logger: { log: text => logs.push(text), warn: text => logs.push(text) },
    channelsFor: c => Object.fromEntries(['telegram', 'email', 'owner'].map(channel => [channel, {
      target: channel === 'owner' ? 999 : channel === 'telegram' ? c.tgChatId : c.email,
      enabled: channel === 'owner' || Boolean(c.notify && c.notify[channel] !== false && (channel === 'telegram' ? c.tgChatId : c.email)),
      transport: channel === 'email' ? 'email' : 'telegram',
      send: async (text, subject) => { calls.push({ channel, text, subject }); return handlers[channel] ? handlers[channel](h, text) : { ok: true }; },
    }])),
  });
  h.run = h.makeRunner();
  h.count = channel => calls.filter(c => c.channel === channel).length;
  h.receipts = channel => Object.keys(h.current().reminderDelivery.channels[channel]?.sent || {});
  h.logs = logs;
  return h;
}

test('owner succeeds, student fails: only student is retried, including after restart', async () => {
  let fail = true;
  const h = harness({ handlers: { telegram: () => ({ ok: !fail }) } });
  const first = await h.run();
  assert.equal(first.failed, 1); assert.equal(first.accepted, 2);
  assert.equal(h.receipts('telegram').length, 0); assert.equal(h.receipts('owner').length, 1);
  await h.run(); assert.equal(h.calls.length, 3);
  fail = false; h.run = h.makeRunner(); h.advance(RETRY_MS);
  await h.run(); assert.equal(h.count('telegram'), 2); assert.equal(h.count('owner'), 1); assert.equal(h.count('email'), 1);
  await h.run(); assert.equal(h.calls.length, 4);
});

test('email success cannot acknowledge a failed student Telegram delivery', async () => {
  const h = harness({ handlers: { telegram: () => ({ ok: false }), owner: () => ({ ok: false }) } });
  await h.run(); h.advance(RETRY_MS); await h.run();
  assert.equal(h.count('email'), 1); assert.equal(h.count('telegram'), 2); assert.equal(h.count('owner'), 2);
});

test('student succeeds, owner fails: only owner repeats', async () => {
  const h = harness({ handlers: { owner: () => ({ ok: false }) } });
  await h.run(); h.advance(RETRY_MS); await h.run();
  assert.equal(h.count('telegram'), 1); assert.equal(h.count('email'), 1); assert.equal(h.count('owner'), 2);
});

test('backoff grows from 15 minutes to 6 hours; no tight retry loop', async () => {
  const h = harness({ handlers: { telegram: () => { throw new Error('private token'); } } });
  for (let attempt = 1; attempt <= 8; attempt++) {
    await h.run();
    const delay = Math.min(RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
    h.advance(delay - 1); await h.run(); assert.equal(h.count('telegram'), attempt);
    h.advance(1);
  }
  assert.equal(h.receipts('telegram').length, 0);
  assert(!h.logs.join('\n').includes('private token'));
});

test('provider retry_after is respected even beyond the normal cap', async () => {
  const h = harness({ handlers: { telegram: () => ({ ok: false, retryAfterMs: 12 * 3600000, rateLimited: true }) } });
  await h.run(); assert.equal(h.count('owner'), 0); assert.equal(h.count('email'), 1);
  h.advance(12 * 3600000 - 1); await h.run(); assert.equal(h.count('telegram'), 1);
  h.advance(1); await h.run(); assert.equal(h.count('telegram'), 2);
});

test('successful sends persist and do not repeat after process restart', async () => {
  const h = harness(); await h.run(); h.run = h.makeRunner(); h.advance(RETRY_MS); await h.run();
  assert.equal(h.calls.length, 3);
});

test('one current urgency band; no 7/3/1 catch-up burst on the same day', async () => {
  const h = harness({ tasks: [task('apply', 1)] });
  await h.run();
  for (let i = 0; i < 4; i++) { h.advance(RETRY_MS); await h.run(); }
  assert.equal(h.count('telegram'), 1);
  h.tasks = [task('apply', 0)]; await h.run(); assert.equal(h.count('telegram'), 1);
  h.tasks = [task('apply', -1)]; await h.run(); assert.equal(h.count('telegram'), 2);
  h.tasks = [task('apply', -2)]; await h.run(); assert.equal(h.count('telegram'), 2);
});

test('7, 3 and 1-day bands fire once each as the deadline approaches', async () => {
  const h = harness();
  for (const days of [7, 6, 5, 4, 3, 2, 1, 0, -1, -2]) { h.tasks = [task('apply', days)]; await h.run(); }
  assert.equal(h.count('telegram'), 4);
});

test('moving a deadline or intake does not inherit old event receipts', async () => {
  const h = harness(); await h.run();
  h.tasks = [task('apply', 7, '2027-09-25')]; h.current().intakeYear = 2027;
  await h.run(); assert.equal(h.count('telegram'), 2);
});

test('new recipient does not inherit the previous chat delivery', async () => {
  const h = harness(); await h.run(); h.current().tgChatId = 101; await h.run();
  assert.equal(h.count('telegram'), 2); assert.equal(h.count('owner'), 1);
});

test('opt-out and unlinked channels are never contacted', async () => {
  const h = harness({ client: { notify: { telegram: false, email: false } } });
  await h.run(); assert.equal(h.count('telegram'), 0); assert.equal(h.count('email'), 0);
  h.current().notify.telegram = true; h.current().tgChatId = null;
  await h.run(); assert.equal(h.count('telegram'), 0);
});

test('opt-out after failure stops the retry', async () => {
  const h = harness({ handlers: { telegram: () => ({ ok: false }) } });
  await h.run(); h.current().notify.telegram = false; h.current().tgChatId = null;
  h.advance(RETRY_MS); await h.run(); assert.equal(h.count('telegram'), 1);
});

test('completed, missing-date and non-finite-date tasks never generate notifications', async () => {
  const h = harness({ client: { done: { complete: true } }, tasks: [
    task('complete'), { ...task('no-date'), deadline: null }, { ...task('no-days'), daysLeft: null },
    { ...task('undefined'), daysLeft: undefined }, { ...task('not-finite'), daysLeft: NaN },
  ] });
  await h.run(); assert.equal(h.calls.length, 0);
});

test('completing a failed task cancels its pending retry', async () => {
  const h = harness({ handlers: { telegram: () => ({ ok: false }) } });
  await h.run(); h.current().done.apply = true; h.advance(RETRY_MS); await h.run();
  assert.equal(h.count('telegram'), 1);
});

test('fresh state after network waits preserves opt-out, progress and documents', async () => {
  const h = harness({ handlers: { telegram: h => {
    h.current().notify.telegram = false; h.current().tgChatId = null;
    h.current().notify.email = false; h.current().done.other = true;
    h.current().docs = { uploaded: { verdict: 'ok' } }; return { ok: true };
  } } });
  await h.run(); assert.equal(h.current().tgChatId, null); assert.equal(h.current().notify.telegram, false);
  assert.equal(h.current().done.other, true); assert.equal(h.current().docs.uploaded.verdict, 'ok');
  assert.equal(h.count('email'), 0);
});

test('a deleted client is not resurrected by a receipt write', async () => {
  const h = harness({ handlers: { telegram: h => { h.store.delete('TEST-001'); return { ok: true }; } } });
  await h.run(); assert.equal(h.store.size, 0); assert.equal(h.calls.length, 1);
  await h.run(); assert.equal(h.store.size, 0);
});

test('a replacement client with the same code does not inherit in-flight receipts', async () => {
  const h = harness({ handlers: { telegram: h => { h.current().createdAt = '2027-01-01'; return { ok: true }; } } });
  await h.run(); assert.equal(Object.keys(h.current().reminderDelivery.channels).length, 0);
});

test('concurrent timer and manual invocation share a single flight', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ handlers: { telegram: async () => { await gate; return { ok: true }; } } });
  const first = h.run(), second = h.run();
  assert.equal(first, second); assert.equal(h.count('telegram'), 1);
  release(); await Promise.all([first, second]); assert.equal(h.calls.length, 3);
});

test('a disk failure before migration prevents sends', async () => {
  const h = harness(); h.failWrite = true;
  assert.equal((await h.run()).storageErrors, 1); assert.equal(h.calls.length, 0);
  h.failWrite = false; await h.run(); assert.equal(h.calls.length, 3);
});

test('successful receipt survives a failed write in memory; persistence is retried before sending', async () => {
  const h = harness({ handlers: { telegram: h => { h.failWrite = true; return { ok: true }; } } });
  await h.run(); assert.equal(h.calls.length, 1);
  h.advance(RETRY_MS); await h.run(); assert.equal(h.calls.length, 1);
  h.failWrite = false; await h.run();
  assert.equal(h.count('telegram'), 1); assert.equal(h.count('email'), 1); assert.equal(h.count('owner'), 1);
  assert.equal(h.receipts('telegram').length, 1);
});

test('legacy history is replay suppression, not a false per-channel success receipt', async () => {
  const h = harness({ client: { reminded: { 'apply:7': '2026-09-18', 'late:over': '2026-09-17' } }, tasks: [task(), task('late', -1)] });
  await h.run(); assert.equal(h.calls.length, 0);
  assert.equal(Object.keys(h.current().reminderDelivery.legacySuppressed).length, 2);
  assert.deepEqual(h.current().reminderDelivery.channels, {});
  h.tasks = [task('apply', 3), task('late', -2)]; await h.run(); assert.equal(h.count('telegram'), 1);
  h.tasks = [task('late', -2, '2027-09-25')]; await h.run(); assert.equal(h.count('telegram'), 2);
});

test('corrupted / unknown ledger is not silently reset and replayed', async () => {
  const h = harness({ client: { reminderDelivery: { version: 999 } } });
  assert.equal((await h.run()).failed, 1); assert.equal(h.calls.length, 0);
});

test('Monday digest sends once per channel/week; a failure retries on Tuesday', async () => {
  let fail = true;
  const h = harness({ tasks: [task('later', 20)], handlers: { telegram: () => ({ ok: !fail }) } });
  h.setTime('2026-09-21T09:00:00'); await h.run(); assert.equal(h.count('owner'), 1);
  h.setTime('2026-09-22T09:00:00'); fail = false; h.run = h.makeRunner(); await h.run();
  assert.equal(h.count('telegram'), 2); assert.equal(h.count('owner'), 1); assert.equal(h.count('email'), 1);
  h.setTime('2026-09-22T10:00:00'); await h.run(); assert.equal(h.count('telegram'), 2);
  h.setTime('2026-09-28T09:00:00'); await h.run(); assert.equal(h.count('telegram'), 3);
});

test('failed urgent band is replaced with current urgency, not a stale message', async () => {
  let fail = true;
  const h = harness({ handlers: { telegram: () => ({ ok: !fail }) } });
  await h.run(); h.advance(RETRY_MS); h.tasks = [task('apply', 3)]; fail = false; await h.run();
  assert.match(h.calls.filter(c => c.channel === 'telegram').at(-1).text, /через 3 дн/);
  assert.equal(h.receipts('telegram').length, 1);
});

test('more than six urgent tasks: only transmitted tasks are marked, remainder is next', async () => {
  const h = harness({ tasks: Array.from({ length: 9 }, (_, i) => task(`t${i}`, 1)) });
  await h.run(); assert.equal(h.receipts('telegram').length, 6);
  await h.run(); assert.equal(h.receipts('telegram').length, 9); assert.equal(h.count('telegram'), 2);
  await h.run(); assert.equal(h.count('telegram'), 2);
});

test('message budget handles long Unicode titles and no client access code in text', async () => {
  const h = harness({ tasks: Array.from({ length: 20 }, (_, i) => ({ ...task(`t${i}`, i < 6 ? 1 : 20), t: '🍋'.repeat(300) })) });
  h.setTime('2026-09-21T09:00:00'); await h.run();
  for (const call of h.calls) assert(call.text.length <= 4096);
  for (const call of h.calls.filter(c => c.channel !== 'owner')) {
    assert(!call.text.includes('TEST-001')); assert.match(call.text, /https:\/\/iitaly.netlify.app\/portal/);
  }
});

test('Telegram acceptance requires HTTP success, ok:true and a message receipt', async t => {
  const variants = [
    ['success', 200, { ok: true, result: { message_id: 123 } }, true],
    ['JSON API error with HTTP 200', 200, { ok: false }, false],
    ['HTTP error', 500, { ok: true, result: { message_id: 123 } }, false],
    ['missing receipt', 200, { ok: true }, false],
    ['blocked', 403, { ok: false, error_code: 403 }, false],
    ['rate limited', 429, { ok: false, parameters: { retry_after: 1200 } }, false],
  ];
  for (const [label, status, body, ok] of variants) await t.test(label, async () => {
    const result = await sendTelegramReminder('fake', 123, 'test', async () => ({ ok: status === 200, status, json: async () => body }));
    assert.equal(result.ok, ok);
    if (status === 429) { assert.equal(result.retryAfterMs, 1200000); assert.equal(result.rateLimited, true); }
    if (status === 403) assert.equal(result.retryAfterMs, 86400000);
  });
});

test('network / malformed JSON / missing token cannot become successful receipts', async () => {
  assert.equal((await sendTelegramReminder('', 1, 'x', () => { throw new Error('must not call'); })).ok, false);
  assert.equal((await sendTelegramReminder('fake', 1, 'x', async () => { throw new Error('network'); })).ok, false);
  assert.equal((await sendTelegramReminder('fake', 1, 'x', async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }))).ok, false);
});

test('Telegram timeout also covers response-body reading and leaves no success receipt', async () => {
  let signal;
  const result = await sendTelegramReminder('fake', 1, 'x', async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
  }, 5);
  assert.equal(signal.aborted, true); assert.equal(result.ok, false);
});
