'use strict';

// Never expose the key (or provider response body) through logs or health routes.
function normalizeApiKey(value) {
  let key = typeof value === 'string' ? value.trim() : '';
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

const CONFIG_ERRORS = {
  401: 'AI_AUTH_INVALID',
  403: 'AI_PERMISSION_DENIED',
  404: 'AI_MODEL_UNAVAILABLE',
};
const ADMIN_MESSAGE = 'ИИ-проверка временно отключена: требуется исправление настроек сервиса. Повторная отправка файла не поможет. Гайды доступны без ИИ.';

function probeFailure(status, body) {
  if (CONFIG_ERRORS[status]) return { code: CONFIG_ERRORS[status], retryable: false };
  // Classify the metadata response, but never return/log its text or identifiers.
  const message = typeof body?.error?.message === 'string' ? body.error.message : '';
  if (status === 402 || body?.error?.type === 'billing_error' || /credit balance/i.test(message)) {
    return { code: 'AI_BILLING_REQUIRED', retryable: false };
  }
  if (status === 400 && /anthropic-workspace-id/i.test(message)) return { code: 'AI_WORKSPACE_REQUIRED', retryable: false };
  if (status === 400) return { code: 'AI_REQUEST_INVALID', retryable: false };
  if (status === 429) return { code: 'AI_RATE_LIMITED', retryable: true };
  return { code: 'AI_PROVIDER_UNAVAILABLE', retryable: true };
}

function createAiReadiness({ apiKey, model, request, now = Date.now, ttlMs = 60000, onChange = () => {} }) {
  let state = { ok: false, code: 'AI_NOT_CHECKED', retryable: true, checkedAt: null };
  let expires = 0, pending = null, revision = 0;
  function publish(ok, code, retryable, details = {}) {
    const changed = state.code !== code || state.providerStatus !== details.providerStatus || state.reason !== details.reason;
    state = { ok, code, retryable, ...details, checkedAt: new Date(now()).toISOString(),
      ...(ok ? {} : { error: retryable ? 'Не удалось подтвердить доступность ИИ. Проверь доступность ещё раз чуть позже.' : ADMIN_MESSAGE }) };
    expires = now() + ttlMs;
    if (changed) onChange({ ok, code, ...details });
    return { ...state };
  }
  function recordFailure(status) {
    const code = CONFIG_ERRORS[status];
    if (!code) return null;
    revision++;
    return publish(false, code, false, { providerStatus: status, reason: 'http_error' });
  }
  async function check() {
    if (expires > now()) return { ...state };
    if (pending) return pending;
    if (!apiKey) return publish(false, 'AI_KEY_MISSING', false);
    if (/[\s\x00-\x1f\x7f]/.test(apiKey)) return publish(false, 'AI_KEY_FORMAT', false);
    const startedAtRevision = revision;
    pending = (async () => {
      try {
        // Metadata only: no user document or generated answer in this probe.
        const response = await request('https://api.anthropic.com/v1/models/' + encodeURIComponent(model), {
          method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        });
        if (revision !== startedAtRevision) return { ...state };
        if (!response.ok) {
          const body = typeof response.json === 'function' ? await response.json().catch(() => null) : null;
          if (revision !== startedAtRevision) return { ...state };
          const failure = probeFailure(response.status, body);
          return publish(false, failure.code, failure.retryable, { providerStatus: response.status, reason: 'http_error' });
        }
        const data = await response.json();
        if (revision !== startedAtRevision) return { ...state };
        if (data?.type !== 'model' || typeof data.id !== 'string') return publish(false, 'AI_PROVIDER_UNAVAILABLE', true, { providerStatus: response.status, reason: 'invalid_response' });
        return publish(true, 'AI_READY', true, { providerStatus: response.status });
      } catch (error) {
        if (revision !== startedAtRevision) return { ...state };
        return publish(false, 'AI_PROVIDER_UNAVAILABLE', true, { reason: error?.name === 'AbortError' ? 'timeout' : 'transport_error' });
      }
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { check, recordFailure, snapshot: () => ({ ...state }) };
}

module.exports = { normalizeApiKey, createAiReadiness };
