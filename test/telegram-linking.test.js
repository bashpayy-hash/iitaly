'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LINK_TTL_MS,
  TOKEN_RE,
  hashToken,
  makeLinkToken,
  validLinkRecord,
  findClientByToken,
} = require('../telegram-linking');

test('one-time Telegram token is high-entropy, URL-safe and only stored as a hash', () => {
  const now = Date.parse('2026-09-19T10:00:00Z');
  const { token, record } = makeLinkToken(now);
  assert.match(token, TOKEN_RE);
  assert.equal(token.length, 43);
  assert.equal(record.hash, hashToken(token));
  assert(!JSON.stringify(record).includes(token));
  assert.equal(Date.parse(record.expiresAt) - now, LINK_TTL_MS);
});

test('link record expires after 15 minutes', () => {
  const now = Date.parse('2026-09-19T10:00:00Z');
  const { record } = makeLinkToken(now);
  assert.equal(validLinkRecord(record, now + LINK_TTL_MS - 1), true);
  assert.equal(validLinkRecord(record, now + LINK_TTL_MS), false);
});

test('lookup matches only the exact live hash and never a code-shaped value', () => {
  const now = Date.parse('2026-09-19T10:00:00Z');
  const { token, record } = makeLinkToken(now);
  const store = new Map([
    ['AAAA-BBBB', { code: 'AAAA-BBBB', tgLink: record }],
    ['CCCC-DDDD', { code: 'CCCC-DDDD', tgLink: makeLinkToken(now).record }],
  ]);
  const listCodes = () => [...store.keys()];
  const readClient = code => store.get(code) || null;

  assert.equal(findClientByToken('AAAA-BBBB', listCodes, readClient, now), null);
  const match = findClientByToken(token, listCodes, readClient, now);
  assert.equal(match.code, 'AAAA-BBBB');
  assert.equal(match.client.code, 'AAAA-BBBB');
});

test('expired or malformed records cannot be linked', () => {
  const now = Date.parse('2026-09-19T10:00:00Z');
  const { token, record } = makeLinkToken(now - LINK_TTL_MS - 1);
  const store = new Map([['AAAA-BBBB', { tgLink: record }]]);
  assert.equal(findClientByToken(token, () => [...store.keys()], code => store.get(code), now), null);
  assert.equal(validLinkRecord({ hash: 'nope', expiresAt: new Date(now + 1000).toISOString() }, now), false);
});
