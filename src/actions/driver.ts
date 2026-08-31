/**
 * What a driver is.
 *
 * One vocabulary, more than one way of reaching an application. The macOS
 * accessibility driver drives native and Electron apps; the CDP driver drives
 * a browser, because a browser reached through accessibility is a worse
 * browser — no URL, no DOM, no stable addressing (`research/08-codex-computeruse.md`
 * §5). Every difference between them stops at this interface: callers name an
 * action and an app, never a mechanism.
 *
 * The method names are the Codex spellings, snake_case and all. This is the
 * one place in the codebase where the house style loses to an external
 * contract on purpose — see `types.ts` for why.
 */
import type {
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

/**
 * How far one `pages` of scrolling moves, in pixels. Shared so a page means
 * the same distance whichever driver delivers the scroll.
 */
export const SCROLL_PAGE_PIXELS = 800;

export interface ActionDriver {
  /** Names the driver in errors and in routing decisions. */
  readonly kind: string;
  /** Whether this driver claims the named app. */
  supports(app: string): boolean;

  click(args: ClickArgs): Promise<void>;
  drag(args: DragArgs): Promise<void>;
  get_app_state(args: GetAppStateArgs): Promise<AppState>;
  list_apps(): Promise<readonly App[]>;
  paste(args: PasteArgs): Promise<void>;
  perform_secondary_action(args: PerformSecondaryActionArgs): Promise<void>;
  press_key(args: PressKeyArgs): Promise<void>;
  scroll(args: ScrollArgs): Promise<void>;
  select_text(args: SelectTextArgs): Promise<void>;
  set_value(args: SetValueArgs): Promise<void>;
  type_text(args: TypeTextArgs): Promise<void>;
}
