/**
 * Routing: one action vocabulary, two ways of reaching an app.
 *
 * The rule is the same one `toolRunner` uses for executors — first claimant
 * wins — so the order drivers are given in is the routing policy, and a
 * general driver belongs last. Nothing here knows what a driver does; it
 * knows which one said yes.
 *
 * This is also where raw arguments are validated. `perform` is the door for
 * anything holding untyped input, and it opens onto the same typed methods
 * the rest of the codebase calls directly.
 *
 * It is also the only place every driver failure passes through while it is
 * still a typed `ActionError`, which is why `onError` exists. Downstream, an
 * executor turns it into a message string, and a caller that wanted to know
 * *why* — `SCREEN_LOCKED` in particular — would be reduced to matching prose.
 * The observer sees the code. It cannot change what happens: the error is
 * rethrown either way, and an observer that throws is ignored.
 */
import type { ActionDriver } from './driver.js';
import { ActionError } from './errors.js';
import type {
  ActionName,
  App,
  AppState,
  ClickArgs,
  DragArgs,
  GetAppStateArgs,
  PasteArgs,
  PerformSecondaryActionArgs,
  PressKeyArgs,
  ScrollArgs,
  SelectTextArgs,
  SetValueArgs,
  TypeTextArgs,
} from './types.js';
import { isActionName, parseActionArgs } from './types.js';

export interface ActionOutcome {
  readonly action: ActionName;
  /** Which driver ran it. `registry` for the ones answered by every driver. */
  readonly driver: string;
  /** `AppState` for a read, `App[]` for `list_apps`, undefined for an action. */
  readonly value: unknown;
}

export interface ActionRegistryDeps {
  /** Sees every `ActionError` a driver throws. Observation only. */
  readonly onError?: (error: ActionError) => void;
}

export class ActionRegistry implements ActionDriver {
  readonly kind = 'registry';

  constructor(
    private readonly drivers: readonly ActionDriver[],
    private readonly deps: ActionRegistryDeps = {},
  ) {}

  supports(app: string): boolean {
    return this.drivers.some((driver) => driver.supports(app));
  }

  /** The driver claiming `app`, in the order they were supplied. */
  route(app: string): ActionDriver {
    const driver = this.drivers.find((candidate) => candidate.supports(app));
    if (driver === undefined) {
      throw new ActionError('NO_DRIVER', `no driver handles '${app}' (drivers: ${this.drivers.map((each) => each.kind).join(', ') || 'none'})`);
    }
    return driver;
  }

  /** Validate untyped arguments and run the action. */
  async perform(action: string, args: unknown): Promise<ActionOutcome> {
    if (!isActionName(action)) throw new ActionError('BAD_ARGS', `unknown action '${action}'`);
    const value = await this.dispatch(action, args);
    const app = (args as { app?: unknown } | null)?.app;
    const driver = action === 'list_apps' || typeof app !== 'string' ? this.kind : this.route(app).kind;
    return { action, driver, value };
  }

  private async dispatch(action: ActionName, raw: unknown): Promise<unknown> {
    switch (action) {
      case 'click':
        return await this.click(parseActionArgs('click', raw));
      case 'drag':
        return await this.drag(parseActionArgs('drag', raw));
      case 'get_app_state':
        return await this.get_app_state(parseActionArgs('get_app_state', raw));
      case 'list_apps':
        parseActionArgs('list_apps', raw);
        return await this.list_apps();
      case 'paste':
        return await this.paste(parseActionArgs('paste', raw));
      case 'perform_secondary_action':
        return await this.perform_secondary_action(parseActionArgs('perform_secondary_action', raw));
      case 'press_key':
        return await this.press_key(parseActionArgs('press_key', raw));
      case 'scroll':
        return await this.scroll(parseActionArgs('scroll', raw));
      case 'select_text':
        return await this.select_text(parseActionArgs('select_text', raw));
      case 'set_value':
        return await this.set_value(parseActionArgs('set_value', raw));
      case 'type_text':
        return await this.type_text(parseActionArgs('type_text', raw));
    }
  }

  // --- the vocabulary, routed --------------------------------------------

  click(args: ClickArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.click(args));
  }

  drag(args: DragArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.drag(args));
  }

  get_app_state(args: GetAppStateArgs): Promise<AppState> {
    return this.via(args.app, (driver) => driver.get_app_state(args));
  }

  /** Every driver's apps, deduplicated by identifier, drivers in order. */
  async list_apps(): Promise<readonly App[]> {
    return await this.observed(async () => {
      const seen = new Set<string>();
      const apps: App[] = [];
      for (const driver of this.drivers) {
        for (const app of await driver.list_apps()) {
          if (seen.has(app.id)) continue;
          seen.add(app.id);
          apps.push(app);
        }
      }
      return apps;
    });
  }

  paste(args: PasteArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.paste(args));
  }

  perform_secondary_action(args: PerformSecondaryActionArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.perform_secondary_action(args));
  }

  press_key(args: PressKeyArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.press_key(args));
  }

  scroll(args: ScrollArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.scroll(args));
  }

  select_text(args: SelectTextArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.select_text(args));
  }

  set_value(args: SetValueArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.set_value(args));
  }

  type_text(args: TypeTextArgs): Promise<void> {
    return this.via(args.app, (driver) => driver.type_text(args));
  }

  // --- observation -------------------------------------------------------

  /** Route to the claiming driver and report whatever it throws. */
  private via<T>(app: string, run: (driver: ActionDriver) => Promise<T>): Promise<T> {
    return this.observed(() => run(this.route(app)));
  }

  private async observed<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ActionError && this.deps.onError !== undefined) {
        try {
          this.deps.onError(error);
        } catch {
          // Intentionally swallowed: watching must not change what happened.
        }
      }
      throw error;
    }
  }
}
