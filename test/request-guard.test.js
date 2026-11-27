'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../request-guard');

test('the limiter counts the visitor Netlify reports, not the Netlify node that connected', () => {
  // Shape measured on the live server with /health/ip on 27 Nov 2026.
  const viaNetlify = node => ({ headers: { 'x-forwarded-for': node + ', 152.233.47.66', 'x-real-ip': node,
    'x-nf-client-connection-ip': '160.79.106.146' }, ip: '::ffff:100.64.0.2' });
  const a = guard.requestIdentity(viaNetlify('3.216.236.164')), b = guard.requestIdentity(viaNetlify('44.218.180.170'));
  assert.equal(a.client, '160.79.106.146'); assert.equal(b.client, '160.79.106.146');
  assert.equal(a.peer, '3.216.236.164'); assert.equal(b.peer, '44.218.180.170');
  const direct = guard.requestIdentity({ headers: { 'x-forwarded-for': '198.51.100.7, 152.233.47.66', 'x-real-ip': '198.51.100.7' } });
  assert.deepEqual(direct, { client: '198.51.100.7', peer: '198.51.100.7' });
  assert.deepEqual(guard.requestIdentity({ headers: { 'x-nf-client-connection-ip': 'not an address\n' }, ip: '127.0.0.1' }),
    { client: '127.0.0.1', peer: '127.0.0.1' });
  assert.deepEqual(guard.requestIdentity({}), { client: 'unknown', peer: 'unknown' });
  // IPv6: one subscriber owns the whole /64, so every address inside it is one caller.
  const v6 = ip => guard.requestIdentity({ headers: { 'x-nf-client-connection-ip': ip, 'x-real-ip': '3.216.236.164' } }).client;
  assert.equal(v6('2a03:d000:1234:5678:aaaa:bbbb:cccc:dddd'), '2a03:d000:1234:5678::/64');
  assert.equal(v6('2A03:D000:1234:5678::1'), '2a03:d000:1234:5678::/64');
  assert.equal(v6('2a03:d000:0:0012::9'), '2a03:d000:0:12::/64');
  assert.notEqual(v6('2a03:d000:1234:5679::1'), v6('2a03:d000:1234:5678::1'));
  assert.equal(v6('::ffff:160.79.106.146'), '160.79.106.146');
});

test('one visitor is limited through any number of nodes; an invented visitor address hits the ceiling of its real machine', () => {
  let time = 0;
  const limit = guard.createDualLimit({ max: 3, windowMs: 1000, peerFactor: 2, now: () => time });
  // The same visitor through a different Netlify node each time: limited after 3.
  const overs = [1, 2, 3, 4, 5].map(i => limit.hit({ client: 'visitor', peer: 'node-' + i }).over);
  assert.deepEqual(overs, [false, false, false, true, true]);
  // A direct caller inventing a new visitor address on every request: stopped at max * peerFactor.
  const forged = Array.from({ length: 8 }, (_, i) => limit.hit({ client: 'fake-' + i, peer: 'attacker' }).over);
  assert.deepEqual(forged, [false, false, false, false, false, false, true, true]);
  assert.equal(limit.blocked({ client: 'someone-new', peer: 'attacker' }), true);
  assert.equal(limit.blocked({ client: 'someone-new', peer: 'another-node' }), false);
  time = 1001;
  assert.equal(limit.hit({ client: 'visitor', peer: 'node-1' }).over, false, 'a new window starts clean');
  limit.sweep();
});

test('the shared budget stops paid calls at the hourly and daily ceilings and reports each crossing once', () => {
  let time = 0;
  const budget = guard.createBudget({ hourly: 3, daily: 5, now: () => time });
  assert.deepEqual([1, 2, 3].map(() => budget.take().ok), [true, true, true]);
  assert.deepEqual(budget.take(), { ok: false, window: 'hour', first: true });
  assert.deepEqual(budget.take(), { ok: false, window: 'hour', first: false });
  time = 3600e3 + 1;
  const fourth = budget.take();
  assert.equal(fourth.ok, true); assert.equal(fourth.nearly, true, '4 of 5 is the 80% mark, reported once');
  assert.equal(budget.take().nearly, false);
  assert.deepEqual(budget.take(), { ok: false, window: 'day', first: true });
  assert.deepEqual(budget.used(), { hour: 2, day: 5 });
  time = 25 * 3600e3;
  assert.equal(budget.take().ok, true, 'the next day starts clean');
});

test('access codes keep their shape and come from the secure generator, never Math.random', t => {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random must not be used for access codes'); };
  t.after(() => { Math.random = original; });
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = guard.makeAccessCode();
    assert.match(code, /^[ACDEFHJKLMNPRTUVWXY3479]{4}-[ACDEFHJKLMNPRTUVWXY3479]{4}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 500);
  let n = 0;
  assert.equal(guard.makeAccessCode(max => { assert.equal(max, 23); return n++ % max; }), 'ACDE-FHJK');
});

test('secrets compare by value without early exit; empty never matches', () => {
  assert.equal(guard.safeEqual('same-secret', 'same-secret'), true);
  assert.equal(guard.safeEqual('same-secret', 'same-secreT'), false);
  assert.equal(guard.safeEqual('short', 'a much longer value'), false);
  assert.equal(guard.safeEqual('', ''), false);
  assert.equal(guard.safeEqual(undefined, 'x'), false);
});

test('a log keeps two files at most and never lets a value start a new line', () => {
  const files = new Map();
  const fs = { statSync: file => { if (!files.has(file)) throw new Error('none'); return { size: Buffer.byteLength(files.get(file)) }; },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    appendFile: (file, text, done) => { files.set(file, (files.get(file) || '') + text); done(); } };
  const log = guard.createCappedLog(fs, '/data/events.log', 40);
  log.append('first line of twenty');
  log.append('second\nforged line');
  assert.equal(files.get('/data/events.log'), 'first line of twenty\nsecond forged line\n');
  log.append('third line goes to a new file');
  assert.equal(files.get('/data/events.log.1'), 'first line of twenty\nsecond forged line\n');
  assert.equal(files.get('/data/events.log'), 'third line goes to a new file\n');
  log.append('fourth line replaces the older file');
  assert.equal(files.get('/data/events.log.1'), 'third line goes to a new file\n');
});

test('an email is one address: nothing a mail server could read as a second recipient or a header', () => {
  for (const good of ['student@example.kz', 'a.b+c@mail.example.com']) assert.equal(guard.validEmail(good), true, good);
  for (const bad of ['a@b.c, evil@x.y', 'a@b.c\nBcc: evil@x.y', 'a@b.c;evil@x.y', '<a@b.c>', 'a@b', 'no-at.example.com',
    '"x"@b.c', 'a@b.c ', 'x'.repeat(80) + '@b.kz', 42, null]) assert.equal(guard.validEmail(bad), false, String(bad));
  assert.equal(guard.plainText('Имя\r\n| LEAD | forged\t', 40), 'Имя | LEAD | forged');
  assert.equal(guard.plainText(42, 40), '');
});
