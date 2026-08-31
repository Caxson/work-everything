import { describe, expect, it } from 'vitest';
import {
  classifyHealth,
  FEISHU_STUCK_STATES,
  FeishuHealthError,
  FeishuHealthMonitor,
  realWindows,
  type HealthObservation,
} from '../src/perception/feishu/health.js';
import type { AxNode, WindowDiagnosis } from '../src/perception/macos/axProtocol.js';

const PID = 4242;
const OK: WindowDiagnosis = { code: 'OK', addressable: 1 };

function reading(overrides: Partial<HealthObservation> = {}): HealthObservation {
  return {
    pid: PID,
    diagnosis: OK,
    windows: [{ role: 'AXWindow', title: '飞书' }],
    webAreaTitles: ['messenger', 'messenger-chat'],
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
    expect(realWindows([{ role: 'AXWindow', title: 'ModalWebViewWidget' }])).toEqual([]);
    expect(realWindows([{ role: 'AXWindow', title: '飞书' }])).toHaveLength(1);
  });

  it('reports only a modal being open as its own thing, not as a fault', () => {
    const health = classifyHealth(reading({ windows: [{ role: 'AXWindow', title: 'ModalWebViewWidget-1' }] }));
    expect(health.state).toBe('no_window');
    expect(health.detail).toContain('modal');
  });
});

describe('the four reasons an app exposes no window', () => {
  // Each of these looks identical from a window count, and each one needs a
  // different sentence said to a person. That is why the helper classifies
  // them and this file no longer guesses from an empty array.

  it('a locked screen: unlock it, and nothing is retried until then', () => {
    const health = classifyHealth(reading({ diagnosis: { code: 'SCREEN_LOCKED', message: 'locked' }, windows: [] }));
    expect(health.state).toBe('screen_locked');
    expect(health.detail).toContain('unlock');
    expect(health.detail).not.toContain('restart');
  });

  it('a blank desktop: a screen saver, on a Mac that is not locked', () => {
    // Measured: a running screen saver takes accessibility windows away from
    // every application while CGSSessionScreenIsLocked stays false. Telling
    // somebody to unlock a Mac that is not locked is the failure to avoid.
    const health = classifyHealth(
      reading({
        windows: [],
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          message: 'nothing is compositing',
          details: { cgWindows: 3, onScreen: 0, desktopOnScreen: 8, desktopOwnersOnScreen: 1, scope: 'desktop' },
        },
      }),
    );
    expect(health.state).toBe('desktop_blank');
    expect(health.detail).toContain('screen saver');
    expect(health.detail).toContain('not locked');
    expect(health.detail).not.toContain('restart Feishu');
    // The census is the evidence, so it travels with the verdict.
    expect(health.detail).toContain('8 on screen machine-wide across 1 process');
  });

  it('windows that exist but are not being drawn: this application only', () => {
    const health = classifyHealth(
      reading({
        windows: [],
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          message: 'not drawn',
          details: { cgWindows: 3, onScreen: 0, desktopOnScreen: 42, desktopOwnersOnScreen: 12, scope: 'application' },
        },
      }),
    );
    expect(health.state).toBe('not_drawn');
    expect(health.detail).toContain('another space');
    expect(health.detail).toContain('3 window(s) known to the window server, 0 on screen');
  });

  it('genuinely no window: closed to the tray, and not an error state', () => {
    const health = classifyHealth(reading({ windows: [], diagnosis: { code: 'NO_WINDOW', message: 'none', details: { cgWindows: 0, onScreen: 0 } } }));
    expect(health.state).toBe('no_window');
    expect(health.detail).toContain('tray');
  });

  it('passes on a cause it does not recognise in the helper’s own words', () => {
    const health = classifyHealth(reading({ windows: [], diagnosis: { code: 'SOMETHING_NEW', message: 'a cause learned later' } }));
    expect(health.state).toBe('no_window');
    expect(health.detail).toBe('a cause learned later');
  });

  it('never escalates a diagnosed cause to wedged, however many times it repeats', () => {
    for (const diagnosis of [
      { code: 'SCREEN_LOCKED' },
      { code: 'NO_WINDOW' },
      { code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES', details: { scope: 'desktop' } },
      { code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES', details: { scope: 'application' } },
    ] satisfies WindowDiagnosis[]) {
      const health = classifyHealth(reading({ windows: [], diagnosis, failures: 99 }), { wedgedAfter: 1 });
      expect(health.state).not.toBe('wedged');
    }
  });
});

describe('the one thing that is actually wedged', () => {
  it('is a window the helper can address with no web content in it, repeatedly', () => {
    expect(classifyHealth(reading({ webAreaTitles: [], failures: 0 })).state).toBe('no_window');
    const health = classifyHealth(reading({ webAreaTitles: [], failures: 3 }));
    expect(health.state).toBe('wedged');
    expect(health.detail).toContain('accessibility layer is wedged');
    expect(health.detail).toContain('restart Feishu');
  });

  it('respects the configured patience', () => {
    expect(classifyHealth(reading({ webAreaTitles: [], failures: 0 }), { wedgedAfter: 1 }).state).toBe('no_window');
    expect(classifyHealth(reading({ webAreaTitles: [], failures: 1 }), { wedgedAfter: 1 }).state).toBe('wedged');
  });

  it('names the states where trying again cannot help', () => {
    expect([...FEISHU_STUCK_STATES].sort()).toEqual(['desktop_blank', 'not_drawn', 'screen_locked', 'wedged']);
  });
});

describe('the health monitor', () => {
  const window: AxNode = { nodeId: 1, role: 'AXWindow', title: '飞书' };
  const webArea: AxNode = { nodeId: 2, role: 'AXWebArea', title: 'messenger-chat' };
  const healthy = { windows: [window], diagnosis: OK };

  it('re-resolves the pid on every check, so a Feishu restart is picked up', async () => {
    let pid = 100;
    const made = new FeishuHealthMonitor({
      pid: async () => (pid += 1),
      windows: async () => healthy,
      webAreas: async () => [webArea],
    });
    expect((await made.check()).pid).toBe(101);
    expect((await made.check()).pid).toBe(102);
  });

  it('takes the diagnosis from the helper rather than inferring one', async () => {
    // Nothing here launches, raises or activates anything: this runs while
    // somebody else is using the Mac.
    const asked: string[] = [];
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => {
        asked.push('windows');
        return { windows: [], diagnosis: { code: 'SCREEN_LOCKED', message: 'locked' } };
      },
      webAreas: async () => {
        asked.push('webAreas');
        return [];
      },
    });
    const health = await made.check();
    expect(health.state).toBe('screen_locked');
    expect(asked).toEqual(['windows', 'webAreas']);
  });

  it('escalates to wedged only after repeated failures, then stays there', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => [],
      config: { wedgedAfter: 2 },
    });
    expect((await made.check()).state).toBe('no_window');
    expect((await made.check()).state).toBe('no_window');
    expect((await made.check()).state).toBe('wedged');
    expect((await made.check()).state).toBe('wedged');
    expect(made.consecutiveFailures).toBeGreaterThanOrEqual(4);
  });

  it('forgets past failures as soon as one reading comes back healthy', async () => {
    let broken = true;
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => (broken ? [] : [webArea]),
      config: { wedgedAfter: 2 },
    });
    await made.check();
    broken = false;
    expect((await made.check()).state).toBe('ok');
    expect(made.consecutiveFailures).toBe(0);
  });

  it('reports a missing process as something to wait for, not as a wedged app', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => {
        throw new Error('Feishu (com.bytedance.macos.feishu) is not running');
      },
      windows: async () => healthy,
      webAreas: async () => [webArea],
    });
    const health = await made.check();
    expect(health.state).toBe('no_window');
    expect(health.detail).toContain('not running');
  });

  it('throws on a wedged app when the caller must not continue', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => [],
      config: { wedgedAfter: 1 },
    });
    await made.check();
    await expect(made.require()).rejects.toBeInstanceOf(FeishuHealthError);
  });

  it('does not throw on anything short of wedged', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => ({ windows: [], diagnosis: { code: 'NO_WINDOW', message: 'tray' } }),
      webAreas: async () => [],
    });
    await expect(made.require()).resolves.toMatchObject({ state: 'no_window' });
  });

  it('survives a web-area read that fails outright', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => {
        throw new Error('find failed');
      },
    });
    expect((await made.check()).state).toBe('no_window');
  });
});
