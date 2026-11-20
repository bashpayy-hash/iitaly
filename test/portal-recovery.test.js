'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  phoneKey, findRecoveryMatches, recoveryText, createRecoveryCooldown, deliverRecovery,
} = require('../portal-recovery');

const normSurname = v => String(v || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

test('phoneKey: +7, 8 and bare national numbers are the same phone; short input is not a phone', () => {
  for (const v of ['+7 700 000 00 01', '87000000001', '7000000001', '+7 (700) 000-00-01']) {
    assert.equal(phoneKey(v), '7000000001');
  }
  assert.equal(phoneKey('12345'), '');
  assert.equal(phoneKey(''), '');
  assert.equal(phoneKey('1'.repeat(16)), '');
});

test('matches need both the surname and the phone of the same cabinet', () => {
  const clients = {
    'AAAA-0001': { code: 'AAAA-0001', surname: 'Ёлкина', phone: '+77000000001' },
    'AAAA-0002': { code: 'AAAA-0002', surname: 'Ёлкина', phone: '+77000000002' },
    'AAAA-0003': { code: 'AAAA-0003', surname: 'Другая', phone: '+77000000001' },
  };
  const deps = { listCodes: () => Object.keys(clients), readClient: code => clients[code] || null, normSurname };
  assert.deepEqual(findRecoveryMatches({ surname: ' елкина ', phone: '87000000001' }, deps).map(m => m.code), ['AAAA-0001']);
  assert.deepEqual(findRecoveryMatches({ surname: 'Ёлкина', phone: '+77000000009' }, deps), []);
  assert.deepEqual(findRecoveryMatches({ surname: 'Ё', phone: '+77000000001' }, deps), []);
  assert.deepEqual(findRecoveryMatches({ surname: 'Ёлкина', phone: '123' }, deps), []);
});

test('recovery text carries the code, the surname and the cabinet link, nothing else', () => {
  const text = recoveryText({ surname: 'Пример', name: 'Тест', phone: '+77000000001', email: 'x@example.invalid' }, 'AAAA-0001', 'https://example.invalid/');
  assert.match(text, /Код: AAAA-0001/);
  assert.match(text, /Фамилия: Пример/);
  assert.match(text, /https:\/\/example\.invalid\/portal/);
  assert.doesNotMatch(text, /77000000001|x@example/);
});

test('cooldown: one send per cabinet in two minutes', () => {
  let now = 0;
  const cooldown = createRecoveryCooldown({ now: () => now });
  assert.equal(cooldown.allow('AAAA-0001'), true);
  assert.equal(cooldown.allow('AAAA-0001'), false);
  assert.equal(cooldown.allow('AAAA-0002'), true);
  now = 2 * 60 * 1000;
  assert.equal(cooldown.allow('AAAA-0001'), true);
});

test('delivery: own channels first; the owner hears only when nothing reached the client', async () => {
  const sent = [];
  const channels = {
    cooldown: createRecoveryCooldown(),
    siteUrl: 'https://example.invalid',
    sendTelegram: async (chat, text) => { sent.push(['tg', chat, text]); return chat !== 404; },
    sendEmail: async (to, subject, text) => { sent.push(['mail', to, text]); return true; },
    alertOwner: async text => { sent.push(['owner', text]); return true; },
  };
  const results = await deliverRecovery([
    { code: 'AAAA-0001', client: { surname: 'А', tgChatId: 1, email: 'a@example.invalid' } },
    { code: 'AAAA-0002', client: { surname: 'Б', tgChatId: null, email: '' } },
    { code: 'AAAA-0003', client: { surname: 'В', tgChatId: 404, email: '' } },
  ], channels);
  assert.deepEqual(results.map(r => r.sent), [['telegram', 'email'], [], []]);
  assert.deepEqual(results.map(r => r.ownerAlerted), [false, true, true]);
  const owner = sent.filter(s => s[0] === 'owner').map(s => s[1]);
  assert.equal(owner.length, 2);
  assert.match(owner[0], /AAAA-0002/);
  assert.match(owner[1], /AAAA-0003/);
  const again = await deliverRecovery([{ code: 'AAAA-0001', client: { surname: 'А', tgChatId: 1 } }], channels);
  assert.equal(again[0].skipped, true);
});
