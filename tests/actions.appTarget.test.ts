import { describe, expect, it } from 'vitest';
import { appKey, appNameFromPath, resolveApp, type RunningApp } from '../src/actions/appTarget.js';
import type { ActionError } from '../src/actions/errors.js';

const feishu: RunningApp = { pid: 1, name: '飞书', bundleId: 'com.bytedance.macos.feishu' };
const chrome: RunningApp = { pid: 2, name: 'Google Chrome', bundleId: 'com.google.Chrome' };
const running = [feishu, chrome];

describe('naming an app', () => {
  it('takes a bundle identifier, a display name or a path', () => {
    expect(resolveApp('com.bytedance.macos.feishu', running)).toBe(feishu);
    expect(resolveApp('Google Chrome', running)).toBe(chrome);
    expect(resolveApp('/Applications/Google Chrome.app', running)).toBe(chrome);
  });

  it('is case-insensitive, the way the identifiers themselves are used', () => {
    expect(resolveApp('google chrome', running)).toBe(chrome);
    expect(resolveApp('COM.GOOGLE.CHROME', running)).toBe(chrome);
  });

  it('hands back the bundle identifier, which is what everything downstream uses', () => {
    // This is the "retry with the bundle id from list_apps" step Codex tells
    // the model to do, done once and deterministically instead.
    expect(appKey(resolveApp('Google Chrome', running))).toBe('com.google.Chrome');
  });

  it('says so when the app is not running, and never launches it', () => {
    try {
      resolveApp('Slack', running);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ActionError).code).toBe('APP_NOT_RUNNING');
      expect((error as ActionError).message).toContain('飞书');
    }
  });

  it('refuses an ambiguous display name rather than picking one', () => {
    const twins = [chrome, { pid: 3, name: 'Google Chrome', bundleId: 'com.google.Chrome.beta' }];
    try {
      resolveApp('Google Chrome', twins);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ActionError).code).toBe('APP_AMBIGUOUS');
      expect((error as ActionError).message).toContain('bundle identifier');
    }
  });

  it('summarises a long running list without dumping all of it', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ pid: index, name: `App${index}`, bundleId: `com.app${index}` }));
    expect(() => resolveApp('Nope', many)).toThrow(/…/);
  });

  it('reads a name out of a path', () => {
    expect(appNameFromPath('/Applications/Lark.app')).toBe('Lark');
    expect(appNameFromPath('/Applications/Lark.app/')).toBe('Lark');
    expect(appNameFromPath('Lark')).toBe('Lark');
  });
});
