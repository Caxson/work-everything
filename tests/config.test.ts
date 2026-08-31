import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, envOverrides, loadConfig, parseConfig } from '../src/config.js';

const dir = mkdtempSync(join(tmpdir(), 'we-config-'));

describe('config', () => {
  it('fills in defaults for an empty object', () => {
    const config = parseConfig({});
    expect(config.router.topK).toBe(8);
    expect(config.trust).toEqual({ required: 3, quarantineAfter: 2, autoReplyChats: [] });
    expect(config.tools).toEqual([]);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expect(() => parseConfig({ nonsense: 1 })).toThrow(ConfigError);
  });

  it('names the offending path when a value is out of range', () => {
    expect(() => parseConfig({ router: { topK: 0 } })).toThrow(/router.topK/);
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() => parseConfig({ llm: { baseUrl: 'not-a-url' } })).toThrow(/llm.baseUrl/);
  });

  it('merges a file under the environment', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ llm: { model: 'from-file', maxTokens: 42 }, router: { topK: 3 } }));
    const config = loadConfig(path, { WORK_EVERYTHING_MODEL: 'from-env' });
    expect(config.llm.model).toBe('from-env');
    expect(config.llm.maxTokens).toBe(42);
    expect(config.router.topK).toBe(3);
  });

  it('reads the config path from the environment when none is given', () => {
    const path = join(dir, 'env-config.json');
    writeFileSync(path, JSON.stringify({ router: { topK: 5 } }));
    expect(loadConfig(undefined, { WORK_EVERYTHING_CONFIG: path }).router.topK).toBe(5);
  });

  it('explains an unreadable or malformed file', () => {
    expect(() => loadConfig(join(dir, 'missing.json'), {})).toThrow(/cannot read config file/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(() => loadConfig(bad, {})).toThrow(/not valid JSON/);
  });

  it('maps the environment variables it knows about', () => {
    expect(envOverrides({ WORK_EVERYTHING_DB: '/tmp/x.db', WORK_EVERYTHING_AX_BINARY: '/opt/we-ax' })).toEqual({
      dbPath: '/tmp/x.db',
      axBridge: { binaryPath: '/opt/we-ax' },
    });
    expect(envOverrides({})).toEqual({});
  });

  it('gives the deferral queue defaults that let a forgotten action die quietly', () => {
    const config = parseConfig({});
    expect(config.queue).toEqual({
      enabled: true,
      ttlMs: 900_000,
      trustResetMs: 300_000,
      capacity: 100,
      pollIntervalMs: 15_000,
      historyLimit: 200,
    });
  });

  it('refuses a reset window longer than the action lifetime, which could never fire', () => {
    // Anything old enough to lose its authorization would already have been
    // dropped as expired, so the trust gate would be unreachable code.
    expect(() => parseConfig({ queue: { ttlMs: 60_000, trustResetMs: 600_000 } })).toThrow(/trustResetMs must not exceed ttlMs/);
    expect(parseConfig({ queue: { ttlMs: 60_000, trustResetMs: 60_000 } }).queue.trustResetMs).toBe(60_000);
  });

  it('rejects queue values that make no sense rather than clamping them silently', () => {
    expect(() => parseConfig({ queue: { capacity: 0 } })).toThrow(/queue/);
    expect(() => parseConfig({ queue: { pollIntervalMs: -1 } })).toThrow(/queue/);
    expect(() => parseConfig({ queue: { pollIntervalMs: 1 } })).toThrow(/queue/);
    expect(() => parseConfig({ queue: { historyLimit: 0 } })).toThrow(/queue/);
    expect(() => parseConfig({ queue: { unknownKey: 1 } })).toThrow(/queue/);
  });

  it('refuses a poll slower than the lifetime it is meant to protect', () => {
    // The drainer would next look at the queue after everything in it had
    // already expired: a queue that provably never drains.
    expect(() => parseConfig({ queue: { ttlMs: 60_000, trustResetMs: 60_000, pollIntervalMs: 3_600_000 } })).toThrow(
      /pollIntervalMs must not exceed ttlMs/,
    );
    expect(parseConfig({ queue: { ttlMs: 60_000, trustResetMs: 60_000, pollIntervalMs: 60_000 } }).queue.pollIntervalMs).toBe(60_000);
  });

  it('validates declared shell tools', () => {
    const config = parseConfig({ tools: [{ name: 'echo', command: '/bin/echo', argv: ['$v'], params: ['v'] }] });
    expect(config.tools[0]).toMatchObject({ name: 'echo', timeoutMs: 30_000, description: '' });
    expect(() => parseConfig({ tools: [{ command: '/bin/echo' }] })).toThrow(/tools.0.name/);
  });
});
