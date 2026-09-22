'use strict';

const crypto = require('node:crypto');

const CURRENCY = 'kzt';
const SIGNATURE_TOLERANCE_SECONDS = 300;

function minorUnits(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('invalid amount');
  return Math.round(value * 100);
}

function redactStripeSecrets(value) {
  return String(value || '')
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+\b/g, '[REDACTED_STRIPE_KEY]')
    .replace(/\bwhsec_[A-Za-z0-9]+\b/g, '[REDACTED_WEBHOOK_SECRET]');
}

async function createCheckoutSession({ secretKey, order, siteUrl, fetchImpl = fetch }) {
  if (!secretKey) return { ok: false, error: 'stripe_not_configured' };
  const base = String(siteUrl || 'https://iitaly.kz').replace(/\/$/, '');
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('success_url', base + '/payment/success');
  body.set('cancel_url', base + '/prices?payment=cancelled');
  body.set('client_reference_id', order.id);
  body.set('metadata[order_id]', order.id);
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', CURRENCY);
  body.set('line_items[0][price_data][unit_amount]', String(minorUnits(order.price)));
  body.set('line_items[0][price_data][product_data][name]', order.product);
  if (order.phone) body.set('metadata[phone_present]', 'true');

  let response;
  try {
    response = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (error) {
    console.error('STRIPE CHECKOUT NETWORK ERROR:', error?.name || 'unknown');
    return { ok: false, error: 'stripe_network' };
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data.id !== 'string' || typeof data.url !== 'string') {
    const stripeError = data && typeof data === 'object' ? data.error : null;
    console.error('STRIPE CHECKOUT API ERROR:', JSON.stringify({
      status: response.status,
      type: stripeError?.type || null,
      code: stripeError?.code || null,
      param: stripeError?.param || null,
      message: redactStripeSecrets(stripeError?.message || ''),
      requestId: response.headers?.get?.('request-id') || null,
    }));
    return { ok: false, error: 'stripe_api' };
  }
  return { ok: true, id: data.id, url: data.url };
}

function parseSignatureHeader(header) {
  const out = { timestamp: null, signatures: [] };
  for (const part of String(header || '').split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) out.timestamp = Number(value);
    if (key === 'v1' && /^[a-f0-9]{64}$/i.test(value)) out.signatures.push(value.toLowerCase());
  }
  return out;
}

function verifyWebhookSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE_SECONDS) {
  if (!secret || !Buffer.isBuffer(rawBody)) return false;
  const parsed = parseSignatureHeader(header);
  if (!Number.isFinite(parsed.timestamp) || parsed.signatures.length === 0) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) return false;
  const payload = Buffer.concat([Buffer.from(String(parsed.timestamp) + '.', 'utf8'), rawBody]);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'hex');
  return parsed.signatures.some(signature => {
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function parseVerifiedEvent(rawBody, header, secret, nowSeconds) {
  if (!verifyWebhookSignature(rawBody, header, secret, nowSeconds)) return null;
  try {
    const event = JSON.parse(rawBody.toString('utf8'));
    return event && typeof event.type === 'string' && event.data && event.data.object ? event : null;
  } catch {
    return null;
  }
}

module.exports = {
  CURRENCY,
  SIGNATURE_TOLERANCE_SECONDS,
  minorUnits,
  createCheckoutSession,
  parseSignatureHeader,
  verifyWebhookSignature,
  parseVerifiedEvent,
};
