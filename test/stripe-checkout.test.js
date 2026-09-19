'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  minorUnits,
  createCheckoutSession,
  verifyWebhookSignature,
  parseVerifiedEvent,
} = require('../stripe-checkout');

test('KZT checkout uses two-decimal minor units and dynamic Stripe payment methods', async () => {
  let request;
  const result = await createCheckoutSession({
    secretKey: 'sk_test_synthetic',
    siteUrl: 'https://iitaly.kz/',
    order: { id: 'ord_0123456789abcdef', product: 'Поступление под ключ', price: 25000, phone: '+77000000000' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/test' }) };
    },
  });
  assert.equal(minorUnits(25000), 2500000);
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.stripe.com/v1/checkout/sessions');
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get('mode'), 'payment');
  assert.equal(body.get('line_items[0][price_data][currency]'), 'kzt');
  assert.equal(body.get('line_items[0][price_data][unit_amount]'), '2500000');
  assert.equal(body.get('client_reference_id'), 'ord_0123456789abcdef');
  assert.equal(body.get('metadata[order_id]'), 'ord_0123456789abcdef');
  assert.equal(body.get('success_url'), 'https://iitaly.kz/payment/success');
  assert.equal(body.get('cancel_url'), 'https://iitaly.kz/prices?payment=cancelled');
  assert.equal(request.options.headers.Authorization, 'Bearer sk_test_synthetic');
});

test('webhook signature verifies exact raw bytes and rejects stale or changed payloads', () => {
  const secret = 'whsec_synthetic';
  const timestamp = 1789819200;
  const raw = Buffer.from(JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed', data: { object: { id: 'cs_test' } } }));
  const signed = Buffer.concat([Buffer.from(timestamp + '.'), raw]);
  const signature = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const header = 't=' + timestamp + ',v1=' + signature;
  assert.equal(verifyWebhookSignature(raw, header, secret, timestamp + 20), true);
  assert.equal(verifyWebhookSignature(Buffer.from(raw.toString() + ' '), header, secret, timestamp + 20), false);
  assert.equal(verifyWebhookSignature(raw, header, secret, timestamp + 301), false);
  assert.equal(parseVerifiedEvent(raw, header, secret, timestamp + 20).type, 'checkout.session.completed');
});

test('missing Stripe secret cannot make a checkout look successful', async () => {
  const result = await createCheckoutSession({
    secretKey: '',
    order: { id: 'ord_0123456789abcdef', product: 'X', price: 1 },
    siteUrl: 'https://iitaly.kz',
    fetchImpl: async () => { throw new Error('must not call'); },
  });
  assert.deepEqual(result, { ok: false, error: 'stripe_not_configured' });
});
