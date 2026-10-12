'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeApiKey, createAiReadiness } = require('../ai-readiness');

test('normalizes pasted whitespace/wrapping quotes without logging a key', () => {
  assert.equal(normalizeApiKey('  "synthetic-key"\n'), 'synthetic-key');
  assert.equal(normalizeApiKey(" 'synthetic-key' "), 'synthetic-key');
  assert.equal(normalizeApiKey(undefined), '');
});

test('missing/malformed key never makes a provider request', async () => {
  for (const [apiKey, code] of [['', 'AI_KEY_MISSING'], ['invalid key\ninside', 'AI_KEY_FORMAT']]) {
    const ai = createAiReadiness({ apiKey, model: 'test-model', request: () => assert.fail('network') });
    const state = await ai.check();
    assert.equal(state.code, code);
    assert.equal(state.ok, false);
    assert.equal(state.retryable, false);
    assert(!JSON.stringify(state).includes('invalid key'));
  }
});

test('malformed workspace ID cannot enter provider headers', async () => {
  for (const workspaceId of ['Default', 'wrkspc_invalid\r\nheader:value', 'wrkspc_']) {
    const ai = createAiReadiness({ apiKey: 'synthetic-key', model: 'test-model', workspaceId,
      request: () => assert.fail('Invalid workspace must not reach the provider') });
    assert.equal((await ai.check()).code, 'AI_WORKSPACE_INVALID');
    assert.equal(ai.snapshot().retryable, false);
  }
});

test('401 is cached, concurrent probes coalesce, and recovery is checked after TTL', async () => {
  let calls = 0, time = 1000, status = 401;
  const ai = createAiReadiness({ apiKey: 'synthetic-key', model: 'test-model', now: () => time,
    request: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.anthropic.com/v1/models/test-model');
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined, 'No user content is sent');
      return { ok: status === 200, status, json: async () => ({ type: 'model', id: 'test-model' }) };
    } });
  const results = await Promise.all([ai.check(), ai.check(), ai.check()]);
  assert.equal(calls, 1);
  assert(results.every(r => r.code === 'AI_AUTH_INVALID' && r.retryable === false));
  status = 200;
  assert.equal((await ai.check()).ok, false);
  time += 60001;
  assert.equal((await ai.check()).ok, true);
  assert.equal(calls, 2);
  assert(!JSON.stringify(ai.snapshot()).includes('synthetic-key'));
});

test('message authorization failure cannot be overwritten by an older metadata probe', async () => {
  let resolveProbe;
  const ai = createAiReadiness({ apiKey: 'synthetic-key', model: 'test-model',
    request: () => new Promise(resolve => { resolveProbe = resolve; }) });
  const pending = ai.check();
  ai.recordFailure(401);
  resolveProbe({ ok: true, status: 200, json: async () => ({ type: 'model', id: 'test-model' }) });
  assert.equal((await pending).code, 'AI_AUTH_INVALID');
  assert.equal((await ai.check()).ok, false);
});

test('permission/model faults require intervention; transport faults remain retryable', async () => {
  for (const [status, code, retryable] of [[403,'AI_PERMISSION_DENIED',false],[404,'AI_MODEL_UNAVAILABLE',false],[529,'AI_PROVIDER_UNAVAILABLE',true]]) {
    const ai = createAiReadiness({ apiKey: 'synthetic-key', model: 'test-model', request: async () => ({ ok: false, status }) });
    const state = await ai.check();
    assert.deepEqual([state.code, state.retryable], [code, retryable]);
  }
  const ai = createAiReadiness({ apiKey: 'synthetic-key', model: 'test-model', request: async () => { throw Error('synthetic-key must never leak'); } });
  const state = await ai.check();
  assert.equal(state.retryable, true);
  assert(!JSON.stringify(state).includes('synthetic-key'));
});

test('metadata failures distinguish billing, workspace, request and rate limits without leaking provider text', async () => {
  const privateValue = 'synthetic-private-provider-value';
  for (const [status, type, message, code, retryable] of [
    [400, 'invalid_request_error', 'Your credit balance is too low. ' + privateValue, 'AI_BILLING_REQUIRED', false],
    [402, 'billing_error', privateValue, 'AI_BILLING_REQUIRED', false],
    [400, 'invalid_request_error', 'Missing anthropic-workspace-id. ' + privateValue, 'AI_WORKSPACE_REQUIRED', false],
    [404, 'not_found_error', 'Workspace `' + privateValue + '` not found.', 'AI_WORKSPACE_UNAVAILABLE', false],
    [400, 'invalid_request_error', privateValue, 'AI_REQUEST_INVALID', false],
    [429, 'rate_limit_error', privateValue, 'AI_RATE_LIMITED', true],
    [503, 'api_error', privateValue, 'AI_PROVIDER_UNAVAILABLE', true],
  ]) {
    const changes = [];
    const ai = createAiReadiness({ apiKey: 'synthetic-key', model: 'test-model', onChange: value => changes.push(value),
      request: async () => ({ ok: false, status, json: async () => ({ error: { type, message } }) }) });
    const state = await ai.check();
    assert.deepEqual([state.code, state.retryable, state.providerStatus, state.reason], [code, retryable, status, 'http_error']);
    assert(!JSON.stringify([state, ai.snapshot(), changes]).includes(privateValue));
    assert(!JSON.stringify([state, ai.snapshot(), changes]).includes('synthetic-key'));
  }
});

test('readiness reports safe response and timeout reasons', async () => {
  const malformed = createAiReadiness({ apiKey: 'synthetic-key', model: 'test-model',
    request: async () => ({ ok: true, status: 200, json: async () => ({ secret: 'private-response' }) }) });
  assert.equal((await malformed.check()).reason, 'invalid_response');
  assert(!JSON.stringify(malformed.snapshot()).includes('private-response'));
  const timeout = createAiReadiness({ apiKey: 'synthetic-key', model: 'test-model',
    request: async () => { const error = new Error('private-response'); error.name = 'AbortError'; throw error; } });
  assert.equal((await timeout.check()).reason, 'timeout');
  assert(!JSON.stringify(timeout.snapshot()).includes('private-response'));
});
