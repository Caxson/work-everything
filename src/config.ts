/**
 * Configuration: defaults, an optional JSON file, and environment overrides.
 *
 * Validated once, at startup, with zod — a bad value should stop the daemon
 * with a readable message rather than surface later as a strange routing
 * decision. Secrets are the exception to "config lives here": API keys are
 * read from the environment at use time and never stored in this object.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { FAILURE_POLICIES } from './core/scenario.js';

export const DEFAULT_STATE_DIR = join(homedir(), '.work-everything');

const ShellToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(''),
    command: z.string().min(1),
    argv: z.array(z.string()).default([]),
    params: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().default(30_000),
    cwd: z.string().optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    dbPath: z.string().min(1).default(join(DEFAULT_STATE_DIR, 'work-everything.db')),
    router: z
      .object({
        muscleThreshold: z.number().min(0).max(10).default(0.35),
        planMatchThreshold: z.number().min(0).max(1).default(0.6),
        topK: z.number().int().positive().default(8),
        planningEnabled: z.boolean().default(true),
        alwaysSlowKinds: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    trust: z
      .object({
        required: z.number().int().positive().default(3),
        quarantineAfter: z.number().int().positive().default(2),
      })
      .strict()
      .default({}),
    promotion: z.object({ promoteAfter: z.number().int().positive().default(3) }).strict().default({}),
    planner: z.object({ maxSteps: z.number().int().positive().max(20).default(5) }).strict().default({}),
    llm: z
      .object({
        baseUrl: z.string().url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
        model: z.string().min(1).default('qwen-flash'),
        timeoutMs: z.number().int().positive().default(20_000),
        temperature: z.number().min(0).max(2).default(0.1),
        maxTokens: z.number().int().positive().default(800),
      })
      .strict()
      .default({}),
    host: z
      .object({
        command: z.string().min(1).default('claude'),
        args: z.array(z.string()).default(['-p', '--output-format', 'json']),
        timeoutMs: z.number().int().positive().default(120_000),
        cwd: z.string().optional(),
      })
      .strict()
      .default({}),
    axBridge: z
      .object({
        binaryPath: z.string().default(join(DEFAULT_STATE_DIR, 'bin', 'we-ax')),
        requestTimeoutMs: z.number().int().positive().default(10_000),
        bundleIds: z.array(z.string()).default([]),
        notifications: z.array(z.string()).default(['AXValueChanged', 'AXFocusedUIElementChanged']),
      })
      .strict()
      .default({}),
    defaultFailurePolicy: z.enum(FAILURE_POLICIES).default('fail_fast'),
    tools: z.array(ShellToolSchema).default([]),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Environment overrides, applied over the file and under nothing. */
export function envOverrides(env: NodeJS.ProcessEnv = process.env): Partial<ConfigInput> {
  const out: Record<string, unknown> = {};
  if (env['WORK_EVERYTHING_DB'] !== undefined) out['dbPath'] = env['WORK_EVERYTHING_DB'];
  const llm: Record<string, unknown> = {};
  if (env['WORK_EVERYTHING_BASE_URL'] !== undefined) llm['baseUrl'] = env['WORK_EVERYTHING_BASE_URL'];
  if (env['WORK_EVERYTHING_MODEL'] !== undefined) llm['model'] = env['WORK_EVERYTHING_MODEL'];
  if (Object.keys(llm).length > 0) out['llm'] = llm;
  if (env['WORK_EVERYTHING_AX_BINARY'] !== undefined) out['axBridge'] = { binaryPath: env['WORK_EVERYTHING_AX_BINARY'] };
  return out as Partial<ConfigInput>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Merge one level deep: nested sections replace wholesale, keys do not. */
function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] =
      typeof value === 'object' && value !== null && !Array.isArray(value) && typeof existing === 'object' && existing !== null && !Array.isArray(existing)
        ? merge(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ConfigError(`invalid configuration: ${detail}`);
  }
  return result.data;
}

/** Load defaults, then the file at `path` if given, then the environment. */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = path ?? env['WORK_EVERYTHING_CONFIG'];
  let fromFile: Record<string, unknown> = {};
  if (file !== undefined && file !== '') {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new ConfigError(`cannot read config file ${file}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    try {
      fromFile = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ConfigError(`config file ${file} is not valid JSON`);
    }
  }
  return parseConfig(merge(fromFile, envOverrides(env) as Record<string, unknown>));
}
