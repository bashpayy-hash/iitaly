'use strict';

const express = require('express');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { mkdir, readFile, open } = require('node:fs/promises');
const { join } = require('node:path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const DATA_DIR = process.env.WHATSAPP_STAGING_DATA_DIR || '/data';
const EVENTS_FILE = join(DATA_DIR, 'whatsapp-webhook-events.jsonl');
const MAX_BYTES = 256 * 1024;
let persistedCount = 0;

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function pseudonym(value) {
  if (value === undefined || value === null || value === '') return null;
  return createHmac('sha256', APP_SECRET).update(String(value)).digest('hex').slice(0, 24);
}

function commandKind(message) {
  const body = message?.type === 'text' ? message.text?.body : '';
  if (typeof body !== 'string') return null;
  const normalized = body.trim();
  if (/^(STOP|СТОП|ОТПИСАТЬСЯ|ОТКЛЮЧИТЬ|UNSUBSCRIBE|IITALY_STOP)$/iu.test(normalized)) return 'opt_out';
  if (/^IITALY LINK [a-f0-9]{64}$/iu.test(normalized)) return 'link';
  return null;
}

function summarizeWebhook(payload) {
  const summary = {
    receivedAt: new Date().toISOString(),
    object: payload?.object === 'whatsapp_business_account' ? payload.object : 'other',
    entries: [],
  };

  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    const entrySummary = { wabaHash: pseudonym(entry?.id), changes: [] };
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      const changeSummary = {
        field: typeof change?.field === 'string' ? change.field.slice(0, 80) : null,
        phoneNumberIdHash: pseudonym(value?.metadata?.phone_number_id),
        statuses: [],
        messages: [],
      };

      for (const status of Array.isArray(value?.statuses) ? value.statuses : []) {
        changeSummary.statuses.push({
          messageIdHash: pseudonym(status?.id),
          recipientHash: pseudonym(status?.recipient_id),
          status: ['sent', 'delivered', 'read', 'failed'].includes(status?.status) ? status.status : 'other',
          timestamp: typeof status?.timestamp === 'string' ? status.timestamp.slice(0, 16) : null,
          errorCodes: (Array.isArray(status?.errors) ? status.errors : [])
            .map(error => Number.isInteger(error?.code) ? error.code : null)
            .filter(code => code !== null)
            .slice(0, 8),
        });
      }

      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        changeSummary.messages.push({
          messageIdHash: pseudonym(message?.id),
          senderHash: pseudonym(message?.from),
          type: typeof message?.type === 'string' ? message.type.slice(0, 40) : 'unknown',
          timestamp: typeof message?.timestamp === 'string' ? message.timestamp.slice(0, 16) : null,
          command: commandKind(message),
        });
      }

      entrySummary.changes.push(changeSummary);
    }
    summary.entries.push(entrySummary);
  }

  return summary;
}

async function appendSummary(summary) {
  const handle = await open(EVENTS_FILE, 'a', 0o600);
  try {
    await handle.writeFile(JSON.stringify(summary) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  persistedCount += 1;
}

async function initialiseStorage() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const existing = await readFile(EVENTS_FILE, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  persistedCount = existing ? existing.split('\n').filter(Boolean).length : 0;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'iitaly-whatsapp-staging',
    storage: { ready: true, persistedEvents: persistedCount },
  });
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

app.post(
  '/api/whatsapp/webhook',
  express.raw({ type: 'application/json', limit: '256kb', inflate: false }),
  async (req, res) => {
    if (!APP_SECRET) return res.status(503).end();
    if (!Buffer.isBuffer(req.body) || req.body.length > MAX_BYTES) return res.status(400).end();

    const signature = req.get('x-hub-signature-256');
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
      return res.status(403).end();
    }

    const expected = 'sha256=' + createHmac('sha256', APP_SECRET).update(req.body).digest('hex');
    if (!equal(signature, expected)) return res.status(403).end();

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).end();
    }

    try {
      await appendSummary(summarizeWebhook(payload));
      // No body, phone number, message text, access token, or raw message ID is logged.
      console.log(`WhatsApp staging webhook: signed event persisted (#${persistedCount})`);
      return res.status(204).end();
    } catch {
      console.error('WhatsApp staging webhook: persistence failed');
      return res.status(503).end();
    }
  }
);

initialiseStorage()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`IITALY WhatsApp staging webhook listening on :${PORT}; persisted=${persistedCount}`);
    });
  })
  .catch(() => {
    console.error('IITALY WhatsApp staging storage initialisation failed');
    process.exit(1);
  });
