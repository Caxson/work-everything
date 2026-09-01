import { describe, expect, it } from 'vitest';
import { ActionRegistry } from '../src/actions/registry.js';
import type { ActionDriver } from '../src/actions/driver.js';
import { ActionError } from '../src/actions/errors.js';
import type { App, AppState } from '../src/actions/types.js';

interface Recorded {
  readonly method: string;
  readonly args: unknown;
}

function stubDriver(kind: string, claims: (app: string) => boolean, apps: readonly App[] = []): ActionDriver & { readonly seen: Recorded[] } {
  const seen: Recorded[] = [];
  const note =
    (method: string) =>
    async (args: unknown): Promise<void> => {
      seen.push({ method, args });
    };
  return {
    kind,
    seen,
    supports: claims,
    click: note('click'),
    drag: note('drag'),
    get_app_state: async (args): Promise<AppState> => {
      seen.push({ method: 'get_app_state', args });
      return { app: args.app, screenshot: null, text: `${kind} text`, snapshotId: `${kind}#1`, diff: false };
    },
    list_apps: async () => apps,
    paste: note('paste'),
    perform_secondary_action: note('perform_secondary_action'),
    press_key: note('press_key'),
    scroll: note('scroll'),
    select_text: note('select_text'),
    set_value: note('set_value'),
    type_text: note('type_text'),
  };
}

const isBrowser = (app: string): boolean => app === 'com.google.Chrome';

describe('routing an action to a driver', () => {
  it('gives the app to the first driver that claims it', async () => {
    const browser = stubDriver('browser_cdp', isBrowser);
    const general = stubDriver('mac_ax', () => true);
    const registry = new ActionRegistry([browser, general]);

    await registry.type_text({ app: 'com.google.Chrome', text: 'hi' });
    await registry.type_text({ app: 'com.bytedance.macos.feishu', text: 'hi' });

    expect(browser.seen.map((call) => call.method)).toEqual(['type_text']);
    expect(general.seen.map((call) => call.method)).toEqual(['type_text']);
  });

  it('honours the order it was given: a general driver last still lets a specific one win', () => {
    const general = stubDriver('mac_ax', () => true);
    const browser = stubDriver('browser_cdp', isBrowser);
    expect(new ActionRegistry([browser, general]).route('com.google.Chrome').kind).toBe('browser_cdp');
    // The same two the wrong way round: the general driver swallows everything.
    expect(new ActionRegistry([general, browser]).route('com.google.Chrome').kind).toBe('mac_ax');
  });

  it('says which drivers exist when none claims the app', () => {
    const registry = new ActionRegistry([stubDriver('browser_cdp', isBrowser)]);
    expect(registry.supports('Notes')).toBe(false);
    try {
      registry.route('Notes');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ActionError).code).toBe('NO_DRIVER');
      expect((error as ActionError).message).toContain('browser_cdp');
    }
  });

  it('routes every one of the eleven methods', async () => {
    const general = stubDriver('mac_ax', () => true);
    const registry = new ActionRegistry([general]);
    const app = 'Notes';
    await registry.click({ app, x: 1, y: 2 });
    await registry.drag({ app, from_x: 0, from_y: 0, to_x: 1, to_y: 1 });
    await registry.get_app_state({ app });
    await registry.list_apps();
    await registry.paste({ app, text: 'x', format: 'text' });
    await registry.perform_secondary_action({ app, element_index: 0, snapshot_id: 's', action: 'AXShowMenu' });
    await registry.press_key({ app, key: 'Return' });
    await registry.scroll({ app, element_index: 0, snapshot_id: 's', direction: 'down' });
    await registry.select_text({ app, element_index: 0, snapshot_id: 's', text: 'x' });
    await registry.set_value({ app, element_index: 0, snapshot_id: 's', value: 'x' });
    await registry.type_text({ app, text: 'x' });

    expect(general.seen.map((call) => call.method)).toEqual([
      'click',
      'drag',
      'get_app_state',
      'paste',
      'perform_secondary_action',
      'press_key',
      'scroll',
      'select_text',
      'set_value',
      'type_text',
    ]);
  });
});

describe('performing an action from untyped input', () => {
  const registry = (): ActionRegistry => new ActionRegistry([stubDriver('browser_cdp', isBrowser, [{ id: 'com.google.Chrome' }]), stubDriver('mac_ax', () => true, [{ id: 'com.apple.Notes' }, { id: 'com.google.Chrome' }])]);

  it('validates before dispatching, and names the driver that ran it', async () => {
    const outcome = await registry().perform('get_app_state', { app: 'com.google.Chrome' });
    expect(outcome.driver).toBe('browser_cdp');
    expect((outcome.value as AppState).text).toBe('browser_cdp text');
  });

  it('rejects an unknown action and bad arguments', async () => {
    await expect(registry().perform('screenshot', { app: 'x' })).rejects.toThrow(/unknown action/);
    await expect(registry().perform('press_key', { app: 'x' })).rejects.toThrow(ActionError);
    await expect(registry().perform('set_value', { app: 'x', element_index: 1, value: 'v' })).rejects.toThrow(/snapshot_id/);
  });

  it('merges the app lists of every driver, keeping the first of a duplicate', async () => {
    const outcome = await registry().perform('list_apps', {});
    expect((outcome.value as readonly App[]).map((app) => app.id)).toEqual(['com.google.Chrome', 'com.apple.Notes']);
    expect(outcome.driver).toBe('registry');
  });

  it('takes an omitted argument object for list_apps', async () => {
    await expect(registry().perform('list_apps', undefined)).resolves.toMatchObject({ action: 'list_apps' });
  });

  it('dispatches every action name it accepts', async () => {
    const app = 'Notes';
    const calls: readonly [string, Record<string, unknown>][] = [
      ['click', { app, x: 1, y: 2 }],
      ['drag', { app, from_x: 0, from_y: 0, to_x: 1, to_y: 1 }],
      ['get_app_state', { app }],
      ['list_apps', {}],
      ['paste', { app, text: 'x', format: 'text' }],
      ['perform_secondary_action', { app, element_index: 0, snapshot_id: 's', action: 'AXShowMenu' }],
      ['press_key', { app, key: 'Return' }],
      ['scroll', { app, element_index: 0, snapshot_id: 's', direction: 'down' }],
      ['select_text', { app, element_index: 0, snapshot_id: 's', text: 'x' }],
      ['set_value', { app, element_index: 0, snapshot_id: 's', value: 'x' }],
      ['type_text', { app, text: 'x' }],
    ];
    const one = registry();
    for (const [action, args] of calls) {
      await expect(one.perform(action, args)).resolves.toMatchObject({ action });
    }
    expect(calls).toHaveLength(11);
  });

  it('reports every driver failure while it is still a typed code', async () => {
    // The one place a SCREEN_LOCKED is still a code rather than a sentence:
    // downstream an executor turns it into a message, and a caller that wanted
    // to know why would be reduced to matching prose.
    const seen: string[] = [];
    const failing: ActionDriver = {
      ...stubDriver('failing', () => true),
      press_key: async () => {
        throw new ActionError('SCREEN_LOCKED', 'the Mac is locked, so no window can be addressed');
      },
    };
    const one = new ActionRegistry([failing], { onError: (error) => seen.push(error.code) });

    await expect(one.press_key({ app: 'com.example', key: 'Return' })).rejects.toThrow(/the Mac is locked/);
    expect(seen).toEqual(['SCREEN_LOCKED']);
  });

  it('reports a failure from an action that names no app', async () => {
    const seen: string[] = [];
    const failing: ActionDriver = {
      ...stubDriver('failing', () => true),
      list_apps: async () => {
        throw new ActionError('NOT_TRUSTED', 'accessibility permission has not been granted');
      },
    };
    const one = new ActionRegistry([failing], { onError: (error) => seen.push(error.code) });

    await expect(one.list_apps()).rejects.toThrow(/permission/);
    expect(seen).toEqual(['NOT_TRUSTED']);
  });

  it('reports the routing failure when no driver claims the app', async () => {
    const seen: string[] = [];
    const one = new ActionRegistry([stubDriver('narrow', (app) => app === 'other')], { onError: (error) => seen.push(error.code) });

    await expect(one.type_text({ app: 'com.example', text: 'x' })).rejects.toThrow(/no driver handles/);
    expect(seen).toEqual(['NO_DRIVER']);
  });

  it('passes a non-ActionError through untouched, and does not report it', async () => {
    const seen: string[] = [];
    const failing: ActionDriver = {
      ...stubDriver('failing', () => true),
      type_text: async () => {
        throw new TypeError('something else entirely');
      },
    };
    const one = new ActionRegistry([failing], { onError: (error) => seen.push(error.code) });

    await expect(one.type_text({ app: 'com.example', text: 'x' })).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it('keeps watching after an observer throws: observation must not change what happened', async () => {
    const failing: ActionDriver = {
      ...stubDriver('failing', () => true),
      type_text: async () => {
        throw new ActionError('SCREEN_LOCKED', 'locked');
      },
    };
    const one = new ActionRegistry([failing], {
      onError: () => {
        throw new Error('the observer is broken');
      },
    });

    // The original error survives; the observer's does not escape.
    await expect(one.type_text({ app: 'com.example', text: 'x' })).rejects.toThrow(/locked/);
  });
});
