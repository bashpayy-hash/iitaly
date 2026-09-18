'use strict';

const express = require('express');
const { createHmac, timingSafeEqual } = require('node:crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const MAX_BYTES = 256 * 1024;

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'iitaly-whatsapp-staging' });
});

app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');

  if (mode !== 'subscribe' || !VERIFY_TOKEN || !equal(token, VERIFY_TOKEN) || !/^\d{1,100}$/.test(challenge)) {
    return res.status(403).end();
  }
  return res.status(200).type('text/plain').send(challenge);
});

// Staging endpoint only: accept POSTs only after an App Secret has been configured
// and the Meta signature verifies. Events are intentionally NOT persisted yet.
app.post('/api/whatsapp/webhook',
  express.raw({ type: 'application/json', limit: '256kb', inflate: false }),
  (req, res) => {
    if (!APP_SECRET) return res.status(503).end();
    if (!Buffer.isBuffer(req.body) || req.body.length > MAX_BYTES) return res.status(400).end();

    const signature = req.get('x-hub-signature-256');
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
      return res.status(403).end();
    }

    const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(req.body).digest('hex');
    if (!equal(signature, expected)) return res.status(403).end();

    // Deliberately do not log body, phone numbers, message text, or IDs.
    console.log('WhatsApp staging webhook: signed event received (not persisted)');
    return res.status(204).end();
  }
);

app.listen(PORT, () => {
  console.log(`IITALY WhatsApp staging webhook listening on :${PORT}`);
});
