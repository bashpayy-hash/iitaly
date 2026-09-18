'use strict';

// Opt-in transport scaffold. Nothing imports this from server.js yet.
const PHONE = /^\+[1-9]\d{7,14}$/;
const TEMPLATE = /^[a-z][a-z0-9_]{0,511}$/;
function phone(value) {
  if (typeof value !== 'string' || !PHONE.test(value)) throw new Error('INVALID_PHONE');
  return value;
}
function timestamp(value, now) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now;
}
function configFromEnv(env = process.env) {
  const mode = env.WHATSAPP_MODE || 'off';
  if (!['off', 'test', 'production'].includes(mode)) throw new Error('INVALID_WHATSAPP_MODE');
  if (mode === 'off') return Object.freeze({ mode });
  const config = {
    mode,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: env.WHATSAPP_API_VERSION,
    templates: {
      due: env.WHATSAPP_TEMPLATE_DUE,
      overdue: env.WHATSAPP_TEMPLATE_OVERDUE,
      digest: env.WHATSAPP_TEMPLATE_DIGEST,
    },
    testRecipients: (env.WHATSAPP_TEST_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
  // Version and approved template names are operator inputs, never guessed.
  if (!config.accessToken || /[\r\n]/.test(config.accessToken) ||
      !/^\d+$/.test(config.phoneNumberId || '') || !/^v\d+\.\d+$/.test(config.apiVersion || '') ||
      Object.values(config.templates).some(name => !TEMPLATE.test(name || ''))) throw new Error('WHATSAPP_CONFIG_INCOMPLETE');
  config.testRecipients.forEach(phone);
  if (mode === 'test' && (!config.testRecipients.length || config.testRecipients.length > 5)) throw new Error('TEST_ALLOWLIST_REQUIRED');
  return Object.freeze(config);
}
function subscriptionAllowed(subscription, now = Date.now()) {
  return Boolean(subscription && subscription.enabled === true && !subscription.revokedAt &&
    PHONE.test(subscription.phone || '') && subscription.verifiedPhone === subscription.phone &&
    timestamp(subscription.verifiedAt, now) && timestamp(subscription.optInAt, now) &&
    subscription.consentVersion === 'iitaly-whatsapp-deadlines-v1');
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\t\x00-\x1f]/.test(value)) throw new Error('INVALID_TEMPLATE_PARAMETER');
  return value.trim();
}
function payloadFor(config, subscription, event) {
  if (!event || !['due', 'overdue', 'digest'].includes(event.kind)) throw new Error('INVALID_EVENT');
  // Fixed, minimal RU schemas. No document contents, account codes or model prose.
  const values = event.kind === 'digest'
    ? [text(event.weekLabel, 40), text(event.summary, 600)]
    : [text(event.taskLabel, 160), text(event.deadlineLabel, 80), text(event.relativeLabel, 40)];
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to: phone(subscription.phone).slice(1), type: 'template',
    template: {
      name: config.templates[event.kind], language: { code: 'ru' },
      components: [{ type: 'body', parameters: values.map(value => ({ type: 'text', text: value })) }],
    },
  };
}
function failure(reason, retryable = false, extra = {}) {
  return { ok: false, state: 'rejected', reason, retryable, ...extra };
}
function createClient(config, { fetchImpl = globalThis.fetch, timeoutMs = 15000, now = Date.now } = {}) {
  if (!config || !['off', 'test', 'production'].includes(config.mode)) throw new Error('INVALID_CONFIG');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('INVALID_TIMEOUT');
  return {
    /** Pass a fresh server-side subscription after claiming a durable outbox job.
     * Never expose this as a public "send to phone" HTTP endpoint. */
    async send(subscription, event) {
      if (config.mode === 'off') return failure('disabled');
      if (!subscriptionAllowed(subscription, now())) return failure('consent_or_phone_not_verified');
      if (config.mode === 'test' && !config.testRecipients.includes(subscription.phone)) return failure('not_allowlisted');
      let payload;
      try { payload = payloadFor(config, subscription, event); }
      catch { return failure('invalid_template_parameters'); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json(); // Timeout covers body consumption as well.
        if (!response.ok || data.error) {
          const code = Number.isInteger(data.error?.code) ? data.error.code : null;
          const throttled = response.status === 429 || [4, 80007, 130429, 131048, 131056].includes(code);
          const transient = throttled || data.error?.is_transient === true;
          const retryAfter = Number(response.headers?.get('retry-after'));
          return failure(throttled ? 'rate_limited' : 'provider_error', transient, {
            httpStatus: response.status, providerCode: code,
            retryAfterMs: transient ? Math.max(900000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0) : null,
          });
        }
        const id = data.messages?.[0]?.id;
        if (typeof id !== 'string' || !/^wamid\.[A-Za-z0-9_+/=.-]+$/.test(id) || id.length > 512) {
          return { ok: false, state: 'unknown', reason: 'missing_receipt', retryable: false };
        }
        // Accepted != delivered/read. Only a signed status webhook advances it.
        return { ok: true, state: 'accepted', messageId: id, acceptedAt: new Date(now()).toISOString() };
      } catch {
        // A timeout may occur after Meta accepted the request. No blind retry.
        return { ok: false, state: 'unknown', reason: controller.signal.aborted ? 'timeout' : 'network_or_invalid_response', retryable: false };
      } finally { clearTimeout(timer); }
    },
  };
}
module.exports = { configFromEnv, createClient, phone, subscriptionAllowed, payloadFor };
