import { describe, expect, it } from 'vitest';
import {
  classifyHealth,
  FeishuHealthError,
  FeishuHealthMonitor,
  realWindows,
  type HealthObservation,
} from '../src/perception/feishu/health.js';
import { parseScreenLocked } from '../src/perception/macos/screenLock.js';
import type { AxNode } from '../src/perception/macos/axProtocol.js';

const PID = 4242;

function reading(overrides: Partial<HealthObservation> = {}): HealthObservation {
  return {
    pid: PID,
    windows: [{ role: 'AXWindow', title: '飞书' }],
    webAreaTitles: ['messenger', 'messenger-chat'],
    screenLocked: false,
    failures: 0,
    ...overrides,
  };
}

describe('classifying one reading of Feishu', () => {
  it('is ok when a real window exposes the conversation web area', () => {
    const health = classifyHealth(reading());
    expect(health.state).toBe('ok');
    expect(health.detail).toContain('conversation open');
  });

  it('is still ok on another sidebar tab, and says which web areas it found', () => {
    const health = classifyHealth(reading({ webAreaTitles: ['history-list'] }));
    expect(health.state).toBe('ok');
    expect(health.detail).toContain('no conversation open');
    expect(health.detail).toContain('history-list');
  });

  it('does not mistake the helper’s application fallback for a window', () => {
    expect(realWindows([{ role: 'AXApplication', title: '飞书' }])).toEqual([]);
    expect(classifyHealth(reading({ windows: [{ role: 'AXApplication', title: '飞书' }] })).state).toBe('no_window');
  });

  it('ignores a modal that is stacked in front of the main window', () => {
    expect(realWindows([{ role: 'AXWindow', title: 'ModalWebViewWidget - main-window' }])).toEqual([]);
  });

  it('blames the locked screen, and never escalates from it however long it lasts', () => {
    const locked = classifyHealth(reading({ windows: [], screenLocked: true, failures: 99 }));
    expect(locked.state).toBe('no_window');
    expect(locked.detail).toContain('screen is locked');
  });

  it('calls a windowless app tray-closed the first few times, not broken', () => {
    const health = classifyHealth(reading({ windows: [], failures: 1 }));
    expect(health.state).toBe('no_window');
    expect(health.detail).toContain('tray');
  });

  it('calls it wedged once reopening it has stopped changing anything', () => {
    const health = classifyHealth(reading({ windows: [], failures: 3 }));
    expect(health.state).toBe('wedged');
    expect(health.detail).toContain('accessibility layer is wedged');
    expect(health.detail).toContain('restart Feishu');
  });

  it('calls a window with no web content at all wedged, after the same patience', () => {
    expect(classifyHealth(reading({ webAreaTitles: [], failures: 0 })).state).toBe('no_window');
    const health = classifyHealth(reading({ webAreaTitles: [], failures: 3 }));
    expect(health.state).toBe('wedged');
    expect(health.detail).toContain('no AXWebArea');
  });

  it('honours a stricter patience setting', () => {
    expect(classifyHealth(reading({ windows: [], failures: 0 }), { wedgedAfter: 1 }).state).toBe('no_window');
    expect(classifyHealth(reading({ windows: [], failures: 1 }), { wedgedAfter: 1 }).state).toBe('wedged');
  });
});

describe('the health monitor', () => {
  const window: AxNode = { nodeId: 1, role: 'AXWindow', title: '飞书' };
  const webArea: AxNode = { nodeId: 2, role: 'AXWebArea', title: 'messenger-chat' };

  it('re-resolves the pid on every check, so a Feishu restart is picked up', async () => {
    let pid = 100;
    const made = new FeishuHealthMonitor({
      pid: async () => (pid += 1),
      windows: async () => [window],
      webAreas: async () => [webArea],
      screenLocked: async () => false,
      requestWindow: async () => undefined,
    });
    expect((await made.check()).pid).toBe(101);
    expect((await made.check()).pid).toBe(102);
  });

  it('asks the app to show a window when there is none, but not while the screen is locked', async () => {
    const reopens: number[] = [];
    const build = (screenLocked: boolean): FeishuHealthMonitor =>
      new FeishuHealthMonitor({
        pid: async () => PID,
        windows: async () => [],
        webAreas: async () => [],
        screenLocked: async () => screenLocked,
        requestWindow: async () => {
          reopens.push(1);
        },
      });

    await build(false).check();
    expect(reopens).toHaveLength(1);
    await build(true).check();
    expect(reopens).toHaveLength(1);
  });

  it('escalates to wedged only after repeated failures, then stays there', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => [],
      webAreas: async () => [],
      screenLocked: async () => false,
      requestWindow: async () => undefined,
      config: { wedgedAfter: 2 },
    });
    expect((await made.check()).state).toBe('no_window');
    expect((await made.check()).state).toBe('no_window');
    expect((await made.check()).state).toBe('wedged');
    expect((await made.check()).state).toBe('wedged');
    expect(made.consecutiveFailures).toBeGreaterThanOrEqual(4);
  });

  it('forgets the failures as soon as the app recovers', async () => {
    let healthy = false;
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => (healthy ? [window] : []),
      webAreas: async () => (healthy ? [webArea] : []),
      screenLocked: async () => false,
      requestWindow: async () => undefined,
      config: { wedgedAfter: 2 },
    });
    await made.check();
    await made.check();
    healthy = true;
    expect((await made.check()).state).toBe('ok');
    expect(made.consecutiveFailures).toBe(0);
  });

  it('reports a missing process as something to wait for, not as a wedged app', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => {
        throw new Error('Feishu (com.bytedance.macos.feishu) is not running');
      },
      windows: async () => [],
      webAreas: async () => [],
      screenLocked: async () => false,
      requestWindow: async () => undefined,
    });
    const health = await made.check();
    expect(health.state).toBe('no_window');
    expect(health.detail).toContain('is not running');
  });

  it('throws on a wedged app when the caller must not continue', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => [],
      webAreas: async () => [],
      screenLocked: async () => false,
      requestWindow: async () => undefined,
      config: { wedgedAfter: 1 },
    });
    await made.check();
    await expect(made.require()).rejects.toBeInstanceOf(FeishuHealthError);
  });

  it('does not throw for a state the caller can simply wait out', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => [],
      webAreas: async () => [],
      screenLocked: async () => true,
      requestWindow: async () => undefined,
    });
    await expect(made.require()).resolves.toMatchObject({ state: 'no_window' });
  });

  it('survives a web-area lookup that fails outright', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => [window],
      webAreas: async () => {
        throw new Error('AX_ERROR(-25204)');
      },
      screenLocked: async () => false,
      requestWindow: async () => undefined,
    });
    expect((await made.check()).state).toBe('no_window');
  });
});

describe('reading the screen lock out of ioreg', () => {
  it('recognises a locked session', () => {
    expect(parseScreenLocked('"IOConsoleUsers" = ({"CGSSessionScreenIsLocked"=Yes,"kCGSSessionIDKey"=257})')).toBe(true);
  });

  it('recognises an unlocked one, and treats a missing key as unlocked', () => {
    expect(parseScreenLocked('"IOConsoleUsers" = ({"CGSSessionScreenIsLocked"=No})')).toBe(false);
    expect(parseScreenLocked('"IOConsoleUsers" = ({"kCGSSessionIDKey"=257})')).toBe(false);
    expect(parseScreenLocked('')).toBe(false);
  });
});
