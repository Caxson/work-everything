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
import { FAILURE_POLICIES, ScenarioSchema } from './core/scenario.js';
import { FEISHU_APP_PATH, FEISHU_BUNDLE_ID } from './perception/feishu/selectors.js';
import { DEFAULT_BROWSER_TARGETS } from './actions/drivers/browserCdp.js';

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
        /**
         * Conversations the daemon may answer without asking first. A chat can
         * be watched (`feishu.allowedChats`) without being answerable: the
         * reply is then printed and recorded for a human instead of sent.
         */
        autoReplyChats: z.array(z.string()).default([]),
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
        /**
         * Unix socket of a resident `we-ax` service, installed by
         * `native/ax-bridge/scripts/install-service.sh`. Set it and the daemon connects
         * instead of spawning a helper.
         *
         * Unset by default, because the socket only exists once somebody has installed the
         * service — but it is the mode an unattended agent needs. macOS attributes an
         * Accessibility grant to the *responsible process*, so a spawned helper inherits
         * the grant of whoever launched the daemon: the same binary reads trusted from a
         * terminal and untrusted from anywhere else, and granting the binary changes
         * nothing. A launchd service is responsible for itself, is granted once by hand,
         * and lends that grant to every caller that can open this socket.
         */
        socketPath: z.string().optional(),
        requestTimeoutMs: z.number().int().positive().default(10_000),
        bundleIds: z.array(z.string()).default([]),
        notifications: z.array(z.string()).default(['AXValueChanged', 'AXFocusedUIElementChanged']),
      })
      .strict()
      .default({}),
    feishu: z
      .object({
        bundleId: z.string().min(1).default(FEISHU_BUNDLE_ID),
        appPath: z.string().min(1).default(FEISHU_APP_PATH),
        /** Display name attributed to the user's own messages. */
        selfName: z.string().default('me'),
        /**
         * Conversation titles that may produce events *and* receive replies.
         * Empty by default: an unconfigured daemon watches nothing and writes
         * nowhere, which is the only safe default for someone's real chat app.
         */
        allowedChats: z.array(z.string()).default([]),
        pollIntervalMs: z.number().int().positive().default(3_000),
        debounceMs: z.number().int().nonnegative().default(250),
        /** Identical reply text to one chat is dropped inside this window. */
        dedupeWindowMs: z.number().int().positive().default(30_000),
        maxTextLength: z.number().int().positive().default(2_000),
      })
      .strict()
      .default({}),
    /**
     * The action layer's timings. The defaults are the ones Codex's runtime
     * uses — about a second of quiet after an action, up to five more while
     * the app still looks busy — and the tree limits are what Feishu needs:
     * its message bodies sit at depth 30–45, and a shallower walk returns a
     * shell of groups that looks exactly like a broken tree.
     */
    actions: z
      .object({
        settleMs: z.number().int().nonnegative().default(1_000),
        maxWaitMs: z.number().int().nonnegative().default(5_000),
        pollMs: z.number().int().positive().default(250),
        treeMaxDepth: z.number().int().positive().default(45),
        treeMaxNodes: z.number().int().positive().default(12_000),
        treeTimeoutMs: z.number().int().positive().default(8_000),
        treePollMs: z.number().int().positive().default(250),
        /** Apps routed to the CDP driver instead of accessibility. */
        browsers: z.array(z.string()).default([...DEFAULT_BROWSER_TARGETS]),
      })
      .strict()
      .default({}),
    /**
     * The deferral queue: what happens to an action decided on while the Mac
     * is locked. The defaults are chosen so a forgotten action dies quietly
     * rather than surprising somebody an hour later.
     */
    queue: z
      .object({
        /** Off means a locked screen fails calls where they stand, as before. */
        enabled: z.boolean().default(true),
        /** How long a queued action is still the action that was authorized. */
        ttlMs: z.number().int().positive().default(900_000),
        /** How long its permission to run unattended survives the wait. */
        trustResetMs: z.number().int().positive().default(300_000),
        capacity: z.number().int().positive().default(100),
        /**
         * How often the bridge is asked whether the screen is still locked.
         * Floored at 100ms: this is a round trip to another process, and a
         * tighter loop buys nothing a person could perceive.
         */
        pollIntervalMs: z.number().int().min(100).default(15_000),
        /** Settled actions kept for `we queue`. At least one, as `settled()` reads. */
        historyLimit: z.number().int().positive().default(200),
      })
      .strict()
      .refine((queue) => queue.trustResetMs <= queue.ttlMs, {
        message:
          'trustResetMs must not exceed ttlMs: a reset window longer than the lifetime can never fire, because anything ' +
          'old enough to have lost its authorization has already been dropped as expired',
      })
      .refine((queue) => queue.pollIntervalMs <= queue.ttlMs, {
        message:
          'pollIntervalMs must not exceed ttlMs: the drainer would next look at the queue after everything in it had ' +
          'already expired, so nothing queued could ever run',
      })
      .default({}),
    defaultFailurePolicy: z.enum(FAILURE_POLICIES).default('fail_fast'),
    tools: z.array(ShellToolSchema).default([]),
    /**
     * Hand-written scenarios. They are written into the registry at startup,
     * so config stays the source of truth for authored muscle memory while
     * promoted scenarios continue to live only in the database.
     */
    scenarios: z.array(ScenarioSchema).default([]),
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
  const axBridge: Record<string, unknown> = {};
  if (env['WORK_EVERYTHING_AX_BINARY'] !== undefined) axBridge['binaryPath'] = env['WORK_EVERYTHING_AX_BINARY'];
  if (env['WORK_EVERYTHING_AX_SOCKET'] !== undefined) axBridge['socketPath'] = env['WORK_EVERYTHING_AX_SOCKET'];
  if (Object.keys(axBridge).length > 0) out['axBridge'] = axBridge;
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
