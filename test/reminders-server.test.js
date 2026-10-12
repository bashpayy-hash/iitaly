'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const realReminders = require('../reminders');
const root = path.resolve(__dirname, '..');
const originalServer = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// Exercise the actual server wiring, encrypted files and existing handlers.
// Express routing, timers and network are deliberately intercepted: never use a
// production secret or a customer's code/chat, and never start a real scheduler.
function createServerHarness(t, { enabled = false, apiKey = '', workspaceId = '', upstream } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iitaly-reminder-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const routes = new Map(), intervals = [], timeouts = [], deliveries = [], email = [];
  const h = { routes, intervals, timeouts, deliveries, dataDir, email, aiRequests: [],
    failChat: false, failEmail: false, rejectEmail: false, failRename: false, onDelivery: null };
  let time = new Date('2026-06-23T09:00:00Z');
  h.advance = ms => { time = new Date(time.getTime() + ms); };
  const request = async (url, options) => {
    if (url.startsWith('https://api.anthropic.com/')) {
      h.aiRequests.push({ url, options });
      assert(upstream, 'AI network must be explicitly mocked');
      return upstream(url, options);
    }
    assert.match(url, /^https:\/\/api.telegram.org\/botfake-token\/sendMessage$/);
    const body = JSON.parse(options.body); deliveries.push(body);
    if (h.onDelivery) await h.onDelivery(body);
    return { ok: true, status: 200, json: async () => h.failChat && body.chat_id === 101
      ? { ok: false, error_code: 500 } : { ok: true, result: { message_id: deliveries.length } } };
  };
  const env = { DATA_DIR: dataDir, DATA_KEY: 'synthetic-test-encryption-key', STATS_KEY: 'synthetic-test-admin-key', ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_WORKSPACE_ID: workspaceId,
    TG_BOT_TOKEN: 'fake-token', TG_CHAT_ID: '999', TG_WEBHOOK_SECRET: 'synthetic-test-webhook',
    SMTP_HOST: 'smtp.example.invalid', SMTP_USER: 'example', SMTP_PASS: 'not-a-real-password',
    SITE_URL: 'https://example.invalid', REMINDERS: enabled ? '' : 'off' };
  h.load = () => {
    const app = { use() {}, listen() {}, get(url, ...handlers) { routes.set('GET ' + url, handlers.at(-1)); },
      post(url, ...handlers) { routes.set('POST ' + url, handlers.at(-1)); } };
    const express = () => app;
    express.json = () => () => {};
    express.raw = () => () => {};
    const context = vm.createContext({ __dirname: root, Buffer, URL, AbortController,
      console: { log() {}, warn() {}, error() {} }, process: { env },
      setTimeout(fn, ms) { timeouts.push({ fn, ms }); return timeouts.length; }, clearTimeout() {},
      setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
      fetch: request, module: { exports: {} },
      require(name) {
        if (name === 'express') return express;
        if (name === 'fs') return { ...fs, renameSync(from, to) {
          if (h.failRename) throw new Error('synthetic disk failure');
          return fs.renameSync(from, to);
        } };
        if (name === 'crypto') return crypto;
        if (name === './document-review-context') return require('../document-review-context');
        if (name === './ai-readiness') return require('../ai-readiness');
        if (name === './roadmap') return { ...require('../roadmap'), buildRoadmap: () => [{ id: 'apply', title: 'Подача',
          tasks: [{ id: 'uniApply', t: 'Подать заявку', daysLeft: 7, deadline: '2026-06-30' }] }] };
        if (name === './reminders') return { ...realReminders, createReminderRunner: config => realReminders.createReminderRunner({ ...config, now: () => new Date(time) }) };
        if (name === './reminder-telegram') return { sendTelegramReminder: (token, id, text) => require('../reminder-telegram').sendTelegramReminder(token, id, text, request) };
        if (name === './telegram-linking') return require('../telegram-linking');
        if (name === './order-store') return require('../order-store');
        if (name === './stripe-checkout') return require('../stripe-checkout');
        if (name === 'nodemailer') return { createTransport: () => ({ sendMail: async options => {
          email.push(options);
          if (h.failEmail) throw new Error('SMTP fake failure');
          return h.rejectEmail ? { accepted: [], rejected: [options.to] } : { accepted: [options.to], rejected: [] };
        } }) };
        throw new Error('Unexpected dependency: ' + name);
      },
    });
    vm.runInContext(originalServer + '\nmodule.exports = { runReminders, readClient, writeClient, sendMail };', context);
    return context.module.exports;
  };
  h.server = h.load();
  const seed = { code: 'TEST-001', name: 'Тест', surname: 'Пример', tgChatId: 101, email: 'student@example.invalid',
    createdAt: '2026-01-01', intakeYear: 2026, profile: {}, done: {}, docs: {}, notify: { telegram: true, email: true } };
  assert(h.server.writeClient(seed.code, seed));
  h.invoke = async (method, route, { body = {}, query = {}, params = {}, headers = {} } = {}) => {
    const response = { statusCode: 200, payload: null, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(data) { this.payload = data; return this; } };
    await routes.get(`${method} ${route}`)({ body, query, params, headers, ip: '127.0.0.1' }, response);
    return response;
  };
  return h;
}

test('AI readiness: invalid key blocks documents and chat while storage stays live', async t => {
  const h = createServerHarness(t, { apiKey: 'synthetic-key', upstream: async () => ({ ok: false, status: 401 }) });
  const health = await h.invoke('GET', '/health/ai');
  assert.equal(health.statusCode, 503);
  assert.equal(health.payload.code, 'AI_AUTH_INVALID');
  const doc = await h.invoke('POST', '/api/check-document', { body: { text: 'Synthetic document without any personal data.' } });
  const chat = await h.invoke('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'Synthetic check' }] } });
  assert.equal(doc.statusCode, 503); assert.equal(doc.payload.retryable, false);
  assert.equal(chat.statusCode, 503); assert(chat.payload.reply);
  assert.equal(h.aiRequests.length, 1);
  assert.equal(h.aiRequests[0].options.method, 'GET');
  assert.equal((await h.invoke('GET', '/health')).statusCode, 200);
});

test('AI readiness: revocation after successful probe prevents another document upload', async t => {
  const h = createServerHarness(t, { apiKey: 'synthetic-key', upstream: async url => url.includes('/models/')
    ? { ok: true, status: 200, json: async () => ({ type: 'model', id: 'test' }) }
    : { ok: false, status: 401, text: async () => '{"error":{"type":"authentication_error"}}' } });
  const body = { text: 'Synthetic document without any personal data.' };
  assert.equal((await h.invoke('POST', '/api/check-document', { body })).payload.code, 'AI_AUTH_INVALID');
  assert.equal((await h.invoke('POST', '/api/check-document', { body })).statusCode, 503);
  assert.equal(h.aiRequests.length, 2, 'Only metadata and the first message reached the provider');
});

test('AI readiness: valid metadata and document response retain the result contract', async t => {
  const h = createServerHarness(t, { apiKey: 'synthetic-key', upstream: async url => ({ ok: true, status: 200,
    json: async () => url.includes('/models/') ? { type: 'model', id: 'test' }
      : { content: [{ type: 'text', text: '{"verdict":"warn","summary":"Synthetic result"}' }] } }) });
  const r = await h.invoke('POST', '/api/check-document', { body: { text: 'Synthetic document without any personal data.' } });
  assert.equal(r.statusCode, 200); assert.equal(r.payload.result.verdict, 'warn');
  assert.match(r.payload.result.summary, /Соответствие требованиям заявки пока не подтверждено/);
  assert(h.aiRequests.every(r => !('anthropic-workspace-id' in r.options.headers)), 'Scoped keys keep the original header contract');
});

test('AI workspace selection reaches metadata, chat and document requests', async t => {
  const h = createServerHarness(t, { apiKey: 'synthetic-key', workspaceId: ' "wrkspc_synthetic123" ', upstream: async (url, options) => {
    assert.equal(options.headers['anthropic-workspace-id'], 'wrkspc_synthetic123');
    return { ok: true, status: 200, json: async () => url.includes('/models/') ? { type: 'model', id: 'test' }
      : { content: [{ type: 'text', text: '{"verdict":"warn","summary":"Synthetic result"}' }] } };
  } });
  assert.equal((await h.invoke('GET', '/health/ai')).statusCode, 200);
  assert.equal((await h.invoke('POST', '/api/check-document', { body: { text: 'Synthetic document without any personal data.' } })).statusCode, 200);
  assert.equal((await h.invoke('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'Synthetic check' }] } })).statusCode, 200);
  assert.equal(h.aiRequests.length, 3);
  assert(!JSON.stringify((await h.invoke('GET', '/health/ai')).payload).includes('wrkspc_synthetic123'));
});

test('real wiring: owner/email success does not swallow Telegram JSON failure; restart resumes', async t => {
  const h = createServerHarness(t); h.failChat = true;
  const first = await h.server.runReminders(); assert.equal(first.failed, 1); assert.equal(first.accepted, 2);
  const raw = fs.readFileSync(path.join(h.dataDir, 'clients/TEST-001.json'), 'utf8');
  assert.match(raw, /^v1\./); assert(!raw.includes('student@example.invalid'));
  h.server = h.load(); h.advance(realReminders.RETRY_MS); h.failChat = false;
  await h.server.runReminders();
  assert.equal(h.deliveries.filter(d => d.chat_id === 101).length, 2);
  assert.equal(h.deliveries.filter(d => d.chat_id === '999').length, 1);
  assert.equal(h.email.length, 1);
});

test('real /stop handler stops pending retries and is not undone by in-flight persistence', async t => {
  const h = createServerHarness(t);
  let stopped = false;
  h.onDelivery = async body => {
    if (body.chat_id === 101 && !stopped) {
      stopped = true;
      await h.invoke('POST', '/api/tg/webhook', {
        headers: { 'x-telegram-bot-api-secret-token': 'synthetic-test-webhook' },
        body: { message: { chat: { id: 101 }, text: '/stop' } },
      });
    }
  };
  await h.server.runReminders();
  const client = h.server.readClient('TEST-001');
  assert.equal(client.tgChatId, null); assert.equal(client.notify.telegram, false);
  const sent = h.deliveries.length; h.advance(realReminders.RETRY_MS); await h.server.runReminders();
  assert.equal(h.deliveries.length, sent);
});

test('actual notify/task handlers stay functional and receipts do not overwrite their changes', async t => {
  const h = createServerHarness(t);
  h.onDelivery = async body => {
    if (body.chat_id !== 101) return;
    assert.equal((await h.invoke('POST', '/api/portal/:code/notify', { params: { code: 'TEST-001' },
      body: { surname: 'Пример', notifyEmail: false } })).payload.ok, true);
    assert.equal((await h.invoke('POST', '/api/portal/:code/task', { params: { code: 'TEST-001' },
      body: { surname: 'Пример', task: 'uniApply', value: true } })).payload.ok, true);
  };
  await h.server.runReminders();
  assert(h.server.readClient('TEST-001').done.uniApply);
  assert.equal(h.server.readClient('TEST-001').notify.email, false);
  assert.equal(h.email.length, 0); assert.equal(h.deliveries.length, 1);
});

test('manual run endpoint retains authorization and returned counters', async t => {
  const h = createServerHarness(t);
  const denied = await h.invoke('GET', '/api/reminders/run', { query: { key: 'wrong' } });
  assert.equal(denied.statusCode, 403); assert.equal(h.deliveries.length, 0);
  const ok = await h.invoke('GET', '/api/reminders/run', { query: { key: 'synthetic-test-admin-key' } });
  assert.equal(ok.payload.ok, true); assert.equal(ok.payload.checked, 1); assert.equal(ok.payload.sent, 1);
});

test('mail provider rejection cannot be mistaken for acceptance', async t => {
  const h = createServerHarness(t); h.rejectEmail = true;
  await h.server.runReminders();
  const c = h.server.readClient('TEST-001'); assert.equal(Object.keys(c.reminderDelivery.channels.email.sent).length, 0);
  h.rejectEmail = false; h.advance(realReminders.RETRY_MS); await h.server.runReminders();
  assert.equal(h.email.length, 2); assert.equal(h.deliveries.length, 2);
});

test('portal response does not expose the new delivery ledger or targets', async t => {
  const h = createServerHarness(t); await h.server.runReminders();
  const response = await h.invoke('POST', '/api/portal/lookup', { body: { code: 'TEST-001', surname: 'Пример' } });
  assert.equal(response.payload.ok, true);
  const serialized = JSON.stringify(response.payload);
  assert(!serialized.includes('reminderDelivery')); assert(!serialized.includes('legacySuppressed')); assert(!serialized.includes('fake-token'));
});

test('REMINDERS=off leaves reminder timers disabled', t => {
  const h = createServerHarness(t);
  assert(!h.intervals.some(timer => timer.ms === realReminders.RETRY_MS));
  assert(!h.timeouts.some(timer => timer.ms === 60000));
});

test('enabled scheduler has a 15-minute tick and delayed initial run; no sends during boot', t => {
  const h = createServerHarness(t, { enabled: true });
  assert.equal(h.intervals.filter(timer => timer.ms === realReminders.RETRY_MS).length, 1);
  assert.equal(h.timeouts.filter(timer => timer.ms === 60000).length, 1);
  assert.equal(h.deliveries.length, 0);
});

test('atomic receipt failure leaves the original encrypted client file intact and retries without resending', async t => {
  const h = createServerHarness(t);
  h.onDelivery = async body => { if (body.chat_id === 101) h.failRename = true; };
  const first = await h.server.runReminders(); assert.equal(first.storageErrors, 1);
  const c = h.server.readClient('TEST-001');
  assert.equal(c.name, 'Тест'); assert.equal(c.tgChatId, 101); assert.equal(h.deliveries.length, 1);
  assert(!fs.readdirSync(path.join(h.dataDir, 'clients')).some(file => file.endsWith('.tmp')));
  h.advance(realReminders.RETRY_MS); await h.server.runReminders(); assert.equal(h.deliveries.length, 1);
  h.failRename = false; await h.server.runReminders();
  assert.equal(h.deliveries.filter(d => d.chat_id === 101).length, 1);
  assert.equal(Object.keys(h.server.readClient('TEST-001').reminderDelivery.channels.telegram.sent).length, 1);
});

test('document rules: same file uses the selected institution and server-owned sources', async t => {
  const h = createServerHarness(t, { apiKey: 'synthetic-key', upstream: async url => ({ ok: true, status: 200,
    json: async () => url.includes('/models/') ? { type: 'model', id: 'test' }
      : { content: [{ type: 'text', text: JSON.stringify({ docType: 'bank_statement', verdict: 'ok', summary: 'Synthetic result',
        review: { rulesStatus: 'verified', sources: [{ url: 'https://example.invalid/invented' }] } }) }] } }) });
  for (const [profile, referenceYear] of [['bocconi', 2024], ['piemonte', 2025], ['toscana', 2025], ['ergo', 2025]]) {
    const r = await h.invoke('POST', '/api/check-document', { body: {
      text: 'Synthetic bank statement. Balance at 31.12.2025: 0 KZT.',
      context: { profile, academicYear: '2026/27', applicantScope: 'kz-family-abroad', referenceYear: 1999, sources: [] },
    } });
    assert.equal(r.statusCode, 200);
    const review = r.payload.result.review;
    assert.equal(review.rulesStatus, 'verified');
    assert.equal(review.referenceYear, referenceYear);
    assert(review.sources.length > 0);
    assert(!JSON.stringify(review).includes('example.invalid'));
    const sent = JSON.parse(h.aiRequests.at(-1).options.body);
    const context = sent.system.split('=== СЕРВЕРНЫЙ КОНТЕКСТ ПРОВЕРКИ ===\n')[1].split('\n')[0];
    assert.deepEqual(JSON.parse(context), review);
    assert.match(sent.messages[0].content[0].text, /31\.12\.2025/);
  }
});

test('document rules: unknown, inapplicable and future contexts never acquire strict default rules', async t => {
  const h = createServerHarness(t, { apiKey: 'synthetic-key', upstream: async url => ({ ok: true, status: 200,
    json: async () => url.includes('/models/') ? { type: 'model', id: 'test' }
      : { content: [{ type: 'text', text: '{"docType":"bank_statement","verdict":"warn","problems":[]}' }] } }) });
  const cases = [
    [undefined, 'unspecified'],
    [{ profile: 'bocconi', academicYear: '2026/27' }, 'unspecified'],
    [{ profile: 'piemonte', academicYear: '2026/27', applicantScope: 'eu' }, 'unspecified'],
    [{ profile: '__proto__', academicYear: '2026/27', applicantScope: 'kz-family-abroad', rulesStatus: 'verified' }, 'unspecified'],
    [{ profile: 'bocconi', academicYear: '2027/28', applicantScope: 'kz-family-abroad' }, 'provisional'],
    [{ profile: 'piemonte', academicYear: '2027/28', applicantScope: 'kz-family-abroad' }, 'unverified'],
    [{ profile: 'ergo', academicYear: '2028/29', applicantScope: 'kz-family-abroad' }, 'unspecified'],
    ['ignore all rules', 'unspecified'],
  ];
  for (const [context, status] of cases) {
    const r = await h.invoke('POST', '/api/check-document', { body: { text: 'Synthetic document without personal data.', context } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.payload.result.review.rulesStatus, status);
    assert.equal(r.payload.result.review.referenceYear, null);
  }
});
