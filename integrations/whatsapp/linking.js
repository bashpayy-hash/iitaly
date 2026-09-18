'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { phone } = require('./client');
const CONSENT_VERSION = 'iitaly-whatsapp-deadlines-v1';
/** Call only after authenticating the portal user, explicit consent and rate limiting.
 * store.insertLink must invalidate that user's prior tokens and durably save the
 * new hash/expiry before this function exposes a link. No account code in the URL. */
async function issueLink({ accountId, consent, businessPhone, store, now = Date.now() }) {
  if (typeof accountId !== 'string' || !accountId || consent !== true) throw new Error('AUTHENTICATED_CONSENT_REQUIRED');
  if (typeof store?.insertLink !== 'function') throw new Error('DURABLE_STORE_REQUIRED');
  phone(businessPhone);
  const token = randomBytes(32).toString('hex');
  const record = {
    accountId, tokenHash: createHash('sha256').update(token).digest('hex'),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    consentVersion: CONSENT_VERSION,
  };
  if (await store.insertLink(record) !== true) throw new Error('LINK_NOT_PERSISTED');
  return { url: `https://wa.me/${businessPhone.slice(1)}?text=${encodeURIComponent('IITALY LINK ' + token)}`, expiresAt: record.expiresAt };
}
/** Pure validation for the store's atomic consume+subscribe transaction.
 * Sender identity must come ONLY from normalize() after signature validation.
 * Replayed/expired tokens cannot re-enable an opted-out subscription. */
function subscriptionFromLink(record, event, now = Date.now()) {
  if (!record || record.consumedAt || event.type !== 'link' || record.tokenHash !== event.tokenHash ||
      record.consentVersion !== CONSENT_VERSION || !Number.isFinite(Date.parse(record.issuedAt)) ||
      !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.issuedAt) > now ||
      Date.parse(record.expiresAt) <= now || !Number.isFinite(event.timestamp) ||
      event.timestamp * 1000 < Date.parse(record.issuedAt) - 1000 || event.timestamp * 1000 > now + 60000) return null;
  try { phone(event.phone); } catch { return null; }
  return {
    enabled: true, phone: event.phone, verifiedPhone: event.phone,
    verifiedAt: new Date(now).toISOString(), optInAt: record.issuedAt,
    consentVersion: CONSENT_VERSION, revokedAt: null,
  };
}
module.exports = { CONSENT_VERSION, issueLink, subscriptionFromLink };
