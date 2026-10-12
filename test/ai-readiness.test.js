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
