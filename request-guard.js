'use strict';

/* Who is calling, and how often (security pass, 27 Nov 2026).

   Measured on the live site: 40 requests in a row passed a limit of 10. The
   limiter keyed on the first X-Forwarded-For value, and behind Netlify that
   value is the Netlify node that proxied the request — eleven different ones
   in fourteen requests. So a single visitor was never limited, and a busy
   node could have limited everyone behind it at once.

   What arrives, measured with /health/ip:
   - X-Nf-Client-Connection-Ip — the visitor, set by Netlify. A forged copy
     sent by the browser does not survive the proxy (checked).
   - X-Real-IP and the first X-Forwarded-For value — the machine that
     connected to Railway: a Netlify node, or the caller itself when someone
     talks to the Railway address directly.

   A caller who skips Netlify can invent the Netlify header. That is why
   every limit is counted twice: per visitor, and per connecting machine with
   a ceiling several times higher. An invented visitor address then still
   runs into the ceiling of the machine it really came from. */

const crypto = require('node:crypto');

const IP_RE = /^[0-9a-f:.]{3,45}$/i;

function cleanIp(value) {
  const text = String(value || '').trim().toLowerCase();
  return IP_RE.test(text) ? text : '';
}

/* One subscriber gets a whole IPv6 block (/64) and can change the address
   inside it on every request, so IPv6 is counted by block. An IPv4 address
   written in IPv6 form is the IPv4 address. */
function addressKey(ip) {
  if (!ip || !ip.includes(':')) return ip;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

function requestIdentity(req) {
  const headers = (req && req.headers) || {};
  const forwarded = String(headers['x-forwarded-for'] || '').split(',').map(cleanIp).filter(Boolean);
  const peer = cleanIp(headers['x-real-ip']) || forwarded[0] || cleanIp(req && req.ip) || 'unknown';
  const client = cleanIp(headers['x-nf-client-connection-ip']) || peer;
  return { client: addressKey(client), peer: addressKey(peer) };
}

/* Fixed-window counter. Memory of one process: enough for one instance;
   a second instance needs a shared store, not another Map. */
function createWindowCounter(windowMs, { now = () => Date.now() } = {}) {
  const records = new Map();
  function current(key) {
    const t = now();
    const record = records.get(key);
    if (!record || t - record.start > windowMs) return { count: 0, start: t };
    return record;
  }
  return {
    windowMs,
    hit(key) {
      const record = current(key);
      record.count++;
      records.set(key, record);
      return { count: record.count, retryAfter: Math.max(1, Math.ceil((record.start + windowMs - now()) / 1000)) };
    },
    count(key) { return current(key).count; },
    sweep() {
      const t = now();
      for (const [key, record] of records) if (t - record.start > windowMs) records.delete(key);
    },
    get size() { return records.size; },
  };
}

/* One limit, counted for the visitor and for the connecting machine.
   check() only reads; hit() counts and says whether the call is over. */
function createDualLimit({ max, windowMs, peerFactor = 10, now }) {
  const perClient = createWindowCounter(windowMs, { now });
  const perPeer = createWindowCounter(windowMs, { now });
  const peerMax = max * peerFactor;
  return {
    max, peerMax,
    blocked(who) {
      return perClient.count(who.client) >= max || perPeer.count(who.peer) >= peerMax;
    },
    hit(who) {
      const a = perClient.hit(who.client), b = perPeer.hit(who.peer);
      return { over: a.count > max || b.count > peerMax, retryAfter: Math.max(a.retryAfter, b.retryAfter) };
    },
    sweep() { perClient.sweep(); perPeer.sweep(); },
  };
}

/* A ceiling on paid work for everyone together (calls to the AI provider).
   Per-address limits stop one address; this stops the bill when the load is
   spread over many addresses. Returns what crossed, so the owner hears once. */
function createBudget({ hourly, daily, now = () => Date.now() }) {
  const hour = createWindowCounter(3600e3, { now });
  const day = createWindowCounter(24 * 3600e3, { now });
  const warned = new Set();
  return {
    hourly, daily,
    take() {
      if (hour.count('all') >= hourly) return { ok: false, window: 'hour', first: firstTime('hour-full:' + windowId(3600e3)) };
      if (day.count('all') >= daily) return { ok: false, window: 'day', first: firstTime('day-full:' + windowId(24 * 3600e3)) };
      hour.hit('all');
      const used = day.hit('all').count;
      const nearly = used === Math.ceil(daily * 0.8) && firstTime('day-80:' + windowId(24 * 3600e3));
      return { ok: true, used, nearly };
    },
    used() { return { hour: hour.count('all'), day: day.count('all') }; },
  };
  function windowId(ms) { return Math.floor(now() / ms); }
  function firstTime(key) {
    if (warned.has(key)) return false;
    if (warned.size > 64) warned.clear();
    warned.add(key);
    return true;
  }
}

/* Compare two secrets without leaking, through timing, how much matched. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

/* Access code: the same alphabet and shape as before (no look-alike
   characters, easy to dictate), but from the system's secure generator.
   Math.random is predictable: a few codes in hand reveal its state, and with
   it the codes issued before and after. */
const CODE_ALPHABET = 'ACDEFHJKLMNPRTUVWXY3479';
function makeAccessCode(randomInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out.slice(0, 4) + '-' + out.slice(4);
}

/* Append-only logs live on the same volume as the cabinets. A log that
   grows without end would fill the volume and stop cabinet saves, so each
   log keeps at most two files of `maxBytes`: the current one and one older. */
function createCappedLog(fs, file, maxBytes) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* no file yet */ }
  return {
    file,
    older: file + '.1',
    append(line) {
      const text = String(line).replace(/[\r\n]+/g, ' ') + '\n';
      const bytes = Buffer.byteLength(text);
      if (size + bytes > maxBytes) {
        try { fs.renameSync(file, file + '.1'); } catch { /* nothing to rotate */ }
        size = 0;
      }
      size += bytes;
      fs.appendFile(file, text, () => {});
    },
  };
}

const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\"]+\.[^\s@,;:<>()[\]\\"]{2,}$/;
function validEmail(value) {
  return typeof value === 'string' && value.length <= 80 && EMAIL_RE.test(value);
}

/* Free text that goes into a log line or a message to the owner. */
function plainText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
}

module.exports = {
  cleanIp, addressKey, requestIdentity, createWindowCounter, createDualLimit, createBudget,
  safeEqual, makeAccessCode, CODE_ALPHABET, createCappedLog, validEmail, plainText,
};
