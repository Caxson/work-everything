/**
 * The LIGHT model call behind the fast tier.
 *
 * One request, one completion, no streaming and no retries beyond a single
 * timeout — planning is an optimization, so a slow or unhappy endpoint should
 * cost the event its fast path, not block the daemon.
 *
 * Credentials come from the environment only. Nothing here reads a key from
 * a config file, logs one, or puts one in an error message.
 */
import type { LightModel } from '../core/planner.js';

export interface LlmConfig {
  readonly baseUrl: string;
  readonly model: string;
  /** Read from the environment by `resolveApiKey`; never hardcoded. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly temperature: number;
  readonly maxTokens: number;
}

/** Environment variables checked, in order, for an API key. */
export const API_KEY_ENV_VARS = ['WORK_EVERYTHING_API_KEY', 'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'] as const;

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of API_KEY_ENV_VARS) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

interface ChatCompletionResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
  readonly error?: { readonly message?: string };
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Build the single-call function the planner takes. `fetchImpl` is injectable
 * so the call can be exercised without a network.
 */
export function createLightModel(config: LlmConfig, fetchImpl: typeof fetch = fetch): LightModel {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    if (config.apiKey === '') throw new LlmError(`no API key: set one of ${API_KEY_ENV_VARS.join(', ')}`);

    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: config.temperature,
          max_tokens: config.maxTokens,
        }),
        signal: combined,
      });
    } catch (error) {
      // The endpoint URL is safe to show; the key never appears here.
      throw new LlmError(`request to ${endpoint} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    if (!response.ok) throw new LlmError(`model endpoint returned HTTP ${response.status}`);

    // Some OpenAI-compatible endpoints answer with a non-JSON content type.
    const body = (await response.json().catch(() => undefined)) as ChatCompletionResponse | undefined;
    if (body === undefined) throw new LlmError('model endpoint returned a body that is not JSON');
    if (body.error?.message !== undefined) throw new LlmError(`model endpoint error: ${body.error.message}`);

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') throw new LlmError('model returned an empty completion');
    return content;
  };
}
