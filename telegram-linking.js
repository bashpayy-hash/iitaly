'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const LINK_TTL_MS = 15 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function makeLinkToken(now = Date.now) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    record: {
      hash: hashToken(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LINK_TTL_MS).toISOString(),
    },
  };
}

function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function validLinkRecord(record, now = Date.now) {
  if (!record || typeof record !== 'object') return false;
  if (!/^[a-f0-9]{64}$/.test(String(record.hash || ''))) return false;
  const expires = Date.parse(String(record.expiresAt || ''));
  return Number.isFinite(expires) && expires > now;
}

function findClientByToken(token, listCodes, readClient, now = Date.now) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const wanted = hashToken(token);
  for (const code of listCodes()) {
    const client = readClient(code);
    if (!client || !validLinkRecord(client.tgLink, now)) continue;
    if (sameHash(client.tgLink.hash, wanted)) return { code, client };
  }
  return null;
}

module.exports = { LINK_TTL_MS, TOKEN_RE, hashToken, makeLinkToken, validLinkRecord, findClientByToken };
