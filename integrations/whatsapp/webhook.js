'use strict';
const { createHmac, timingSafeEqual, createHash } = require('node:crypto');
const { phone } = require('./client');
const MAX_BYTES = 256 * 1024;
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function validSignature(body, signature, appSecret) {
  if (!Buffer.isBuffer(body) || body.length > MAX_BYTES || !appSecret ||
      typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return equal(signature, 'sha256=' + createHmac('sha256', appSecret).update(body).digest('hex'));
}
function identifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }
function seconds(value) { return typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : null; }
function recipient(value) { try { return phone('+' + value); } catch { return null; } }
function eventKey(parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function normalize(payload, { wabaId, phoneNumberId }) {
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return [];
  const events = [];
  for (const entry of payload.entry) {
    if (entry.id !== wabaId || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const value = change.value;
      if (change.field !== 'messages' || value?.messaging_product !== 'whatsapp' || value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!identifier(s.id) || !['sent', 'delivered', 'read', 'failed'].includes(s.status) || seconds(s.timestamp) === null || !recipient(s.recipient_id)) continue;
        events.push({
          key: eventKey([wabaId, phoneNumberId, s.id, s.status, s.timestamp]),
          type: 'status', messageId: s.id, phone: recipient(s.recipient_id),
          status: s.status, timestamp: seconds(s.timestamp),
          errorCodes: (Array.isArray(s.errors) ? s.errors : []).map(e => e.code).filter(Number.isInteger),
        });
      }
      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        if (!identifier(m.id) || !recipient(m.from) || seconds(m.timestamp) === null) continue;
        const value = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.payload : m.type === 'interactive' ? m.interactive?.button_reply?.id : '';
        if (typeof value !== 'string') continue;
        const command = value.trim();
        const link = /^IITALY LINK ([a-f0-9]{64})$/i.exec(command);
        const stop = /^(STOP|СТОП|ОТПИСАТЬСЯ|ОТКЛЮЧИТЬ|UNSUBSCRIBE|IITALY_STOP)$/iu.test(command);
        if (!link && !stop) continue; // Do not retain arbitrary chats/documents.
        events.push({
          key: eventKey([wabaId, phoneNumberId, m.id]), type: stop ? 'opt_out' : 'link',
          messageId: m.id, phone: recipient(m.from), timestamp: seconds(m.timestamp),
          ...(link ? { tokenHash: createHash('sha256').update(link[1].toLowerCase()).digest('hex') } : {}),
        });
      }
    }
  }
  return events;
}
function createWebhookHandlers({ appSecret, verifyToken, wabaId, phoneNumberId, persistEvents }) {
  if (!appSecret || !verifyToken || !/^\d+$/.test(wabaId || '') || !/^\d+$/.test(phoneNumberId || '') || typeof persistEvents !== 'function') throw new Error('WEBHOOK_CONFIG_INCOMPLETE');
  return {
    verify(req, res) {
      const query = req.query || {};
      if (query['hub.mode'] !== 'subscribe' || !equal(query['hub.verify_token'], verifyToken) ||
          typeof query['hub.challenge'] !== 'string' || !/^\d{1,100}$/.test(query['hub.challenge'])) return res.status(403).end();
      return res.status(200).type('text/plain').send(query['hub.challenge']);
    },
    async receive(req, res) {
      if (!Buffer.isBuffer(req.body)) return res.status(400).end();
      if (req.body.length > MAX_BYTES) return res.status(413).end();
      if (!validSignature(req.body, req.get('x-hub-signature-256'), appSecret)) return res.status(403).end();
      let events;
      try { events = normalize(JSON.parse(req.body.toString('utf8')), { wabaId, phoneNumberId }); }
      catch { return res.status(400).end(); }
      try {
        // Implement this as a durable idempotent transaction, including opt-out.
        // Return true only after commit. No send or sensitive log in this handler.
        if (events.length && await persistEvents(events) !== true) return res.status(503).end();
        return res.status(200).end();
      } catch { return res.status(503).end(); }
    },
  };
}
/** Use inside the same transaction as webhook dedupe. Ignore unknown messages. */
function advanceStatus(current, event) {
  if (!current || event.type !== 'status' || current.messageId !== event.messageId || current.phone !== event.phone) return current;
  const rank = { accepted: 0, sent: 1, delivered: 2, read: 3 };
  if (event.status === 'failed') {
    if ((rank[current.state] || 0) >= 2 || event.timestamp < (current.statusTimestamp || 0)) return current;
    return { ...current, state: 'failed', statusTimestamp: event.timestamp, errorCodes: event.errorCodes };
  }
  if (!(event.status in rank)) return current;
  if (current.state === 'failed' && rank[event.status] < 2) return current;
  if (rank[event.status] <= (rank[current.state] ?? -1)) return current;
  return { ...current, state: event.status, statusTimestamp: event.timestamp, errorCodes: [] };
}
module.exports = { MAX_BYTES, validSignature, normalize, createWebhookHandlers, advanceStatus };
