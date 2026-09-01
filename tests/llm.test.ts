import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_ENV_VARS, createLightModel, LlmError, resolveApiKey } from '../src/llm/openaiCompatible.js';
import type { LlmConfig } from '../src/llm/openaiCompatible.js';

const config: LlmConfig = {
  baseUrl: 'https://example.test/v1/',
  model: 'light-model',
  apiKey: 'sk-test',
  timeoutMs: 500,
  temperature: 0.1,
  maxTokens: 100,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

afterEach(() => vi.restoreAllMocks());

describe('api key resolution', () => {
  it('prefers the project variable and falls back in order', () => {
    expect(resolveApiKey({ DASHSCOPE_API_KEY: 'a', WORK_EVERYTHING_API_KEY: 'b' })).toBe('b');
    expect(resolveApiKey({ DEEPSEEK_API_KEY: ' c ' })).toBe('c');
    expect(resolveApiKey({})).toBeUndefined();
    expect(API_KEY_ENV_VARS).toContain('OPENAI_API_KEY');
  });
});

describe('light model call', () => {
  it('posts to the completions endpoint and returns the content', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '{"intent":null}' } }] }));
    const model = createLightModel(config, fetchImpl as unknown as typeof fetch);
    expect(await model('plan this')).toBe('{"intent":null}');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'light-model', messages: [{ role: 'user', content: 'plan this' }] });
  });

  it('refuses to call without a key, and names the variables to set', async () => {
    const model = createLightModel({ ...config, apiKey: '' }, (async () => jsonResponse({})) as unknown as typeof fetch);
    await expect(model('x')).rejects.toThrow(/DASHSCOPE_API_KEY/);
  });

  it('never puts the key in an error message', async () => {
    const model = createLightModel(config, (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    await expect(model('x')).rejects.toThrow(/example.test/);
    await expect(model('x')).rejects.not.toThrow(/sk-test/);
  });

  it('reports an HTTP failure', async () => {
    const model = createLightModel(config, (async () => jsonResponse({}, 429)) as unknown as typeof fetch);
    await expect(model('x')).rejects.toThrow(/HTTP 429/);
  });

  it('reports a body that is not JSON', async () => {
    const model = createLightModel(config, (async () => ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } }) as unknown as Response) as unknown as typeof fetch);
    await expect(model('x')).rejects.toThrow(/not JSON/);
  });

  it('surfaces an error object the endpoint returns with HTTP 200', async () => {
    const model = createLightModel(config, (async () => jsonResponse({ error: { message: 'quota exceeded' } })) as unknown as typeof fetch);
    await expect(model('x')).rejects.toThrow(/quota exceeded/);
  });

  it('treats an empty completion as a failure', async () => {
    const model = createLightModel(config, (async () => jsonResponse({ choices: [{ message: { content: '  ' } }] })) as unknown as typeof fetch);
    await expect(model('x')).rejects.toBeInstanceOf(LlmError);
  });
});
