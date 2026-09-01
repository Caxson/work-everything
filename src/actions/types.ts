/**
 * The action vocabulary.
 *
 * These eleven methods, their parameter names and their value aliases are
 * taken **verbatim** from the computer-use skill OpenAI ships with Codex
 * (`~/.codex/plugins/cache/openai-bundled/computer-use/<version>/skills/computer-use/SKILL.md`,
 * transcribed in `research/08-codex-computeruse.md` §2.2). Copying it exactly
 * is the point: a model that has seen `element_index`, `mouse_button`,
 * `click_count`, `disableDiff` and `perform_secondary_action` under those
 * spellings can drive this layer without being taught a second dialect. The
 * one camelCase name in an otherwise snake_case surface — `disableDiff` — is
 * theirs, and is reproduced rather than tidied.
 *
 * Two things are ours and are marked as such:
 *
 * - `snapshot_id` on every action that addresses an element by index. Codex
 *   relies on a prompt telling the model to re-read state after acting; that
 *   is an instruction, not a guarantee, and a stale index clicks the wrong
 *   thing silently. Binding the index to the reading it came from turns that
 *   into a rejected call (EYHN's approach, `research/08-codex-computeruse.md`
 *   §8 item 10).
 * - `snapshotId` and `diff` on `AppState`, so the caller can act on what it
 *   just read and can tell a diff from a full tree.
 */
import { z } from 'zod';
import { ActionError } from './errors.js';

export const ACTION_NAMES = [
  'click',
  'drag',
  'get_app_state',
  'list_apps',
  'paste',
  'perform_secondary_action',
  'press_key',
  'scroll',
  'select_text',
  'set_value',
  'type_text',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

/** Long and short spellings both accepted, as in the original. */
export const DIRECTIONS = ['up', 'down', 'left', 'right', 'u', 'd', 'l', 'r'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const MOUSE_BUTTONS = ['left', 'right', 'middle', 'l', 'r', 'm'] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];

export const SELECTION_TYPES = ['text', 'cursor_before', 'cursor_after'] as const;
export type SelectionType = (typeof SELECTION_TYPES)[number];

export const PASTE_FORMATS = ['text', 'md', 'html'] as const;
export type PasteFormat = (typeof PASTE_FORMATS)[number];

const DIRECTION_CANON: Readonly<Record<Direction, 'up' | 'down' | 'left' | 'right'>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  u: 'up',
  d: 'down',
  l: 'left',
  r: 'right',
};

const BUTTON_CANON: Readonly<Record<MouseButton, 'left' | 'right' | 'middle'>> = {
  left: 'left',
  right: 'right',
  middle: 'middle',
  l: 'left',
  r: 'right',
  m: 'middle',
};

export function canonicalDirection(direction: Direction): 'up' | 'down' | 'left' | 'right' {
  return DIRECTION_CANON[direction];
}

export function canonicalButton(button: MouseButton): 'left' | 'right' | 'middle' {
  return BUTTON_CANON[button];
}

// --- observations ----------------------------------------------------------

export interface Screenshot {
  readonly url: string;
}

/** One running application, as `list_apps` reports it. */
export interface App {
  /** Bundle identifier: the identifier every other call should be given. */
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly lastUsedDate?: string | undefined;
  readonly useCount?: number | undefined;
  readonly isRunning?: boolean | undefined;
}

export interface AppState {
  readonly app: string;
  /** Null when the driver has no capture path. Never a fabricated URL. */
  readonly screenshot: Screenshot | null;
  /** The accessibility text: the whole tree, or a diff against the last one. */
  readonly text: string;
  /** Ours: the token an `element_index` from this reading must be paired with. */
  readonly snapshotId: string;
  /** Ours: whether `text` is a diff. False after `disableDiff` or a first read. */
  readonly diff: boolean;
}

// --- arguments -------------------------------------------------------------

/** Display name, full app path, or bundle identifier — all three accepted. */
const AppQuery = z.string().min(1, 'app must be a display name, an app path, or a bundle identifier');
const ElementIndex = z.number().int().nonnegative();
const SnapshotId = z.string().min(1);

const NEEDS_SNAPSHOT = 'an action addressing element_index must carry the snapshot_id of the get_app_state it was read from';

export const ClickArgsSchema = z
  .object({
    app: AppQuery,
    element_index: ElementIndex.optional(),
    snapshot_id: SnapshotId.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    mouse_button: z.enum(MOUSE_BUTTONS).optional(),
    click_count: z.number().int().positive().max(3).optional(),
  })
  .strict()
  .refine((args) => args.element_index !== undefined || (args.x !== undefined && args.y !== undefined), {
    message: 'click needs an element_index, or both x and y',
  })
  .refine((args) => args.element_index === undefined || args.snapshot_id !== undefined, { message: NEEDS_SNAPSHOT });
export type ClickArgs = z.infer<typeof ClickArgsSchema>;

export const DragArgsSchema = z
  .object({ app: AppQuery, from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() })
  .strict();
export type DragArgs = z.infer<typeof DragArgsSchema>;

export const GetAppStateArgsSchema = z.object({ app: AppQuery, disableDiff: z.boolean().optional() }).strict();
export type GetAppStateArgs = z.infer<typeof GetAppStateArgsSchema>;

export const ListAppsArgsSchema = z.object({}).strict();
export type ListAppsArgs = z.infer<typeof ListAppsArgsSchema>;

export const PasteArgsSchema = z.object({ app: AppQuery, text: z.string(), format: z.enum(PASTE_FORMATS) }).strict();
export type PasteArgs = z.infer<typeof PasteArgsSchema>;

export const PerformSecondaryActionArgsSchema = z
  .object({ app: AppQuery, element_index: ElementIndex, snapshot_id: SnapshotId, action: z.string().min(1) })
  .strict();
export type PerformSecondaryActionArgs = z.infer<typeof PerformSecondaryActionArgsSchema>;

export const PressKeyArgsSchema = z.object({ app: AppQuery, key: z.string().min(1) }).strict();
export type PressKeyArgs = z.infer<typeof PressKeyArgsSchema>;

export const ScrollArgsSchema = z
  .object({
    app: AppQuery,
    element_index: ElementIndex,
    snapshot_id: SnapshotId,
    direction: z.enum(DIRECTIONS),
    pages: z.number().positive().max(50).optional(),
  })
  .strict();
export type ScrollArgs = z.infer<typeof ScrollArgsSchema>;

export const SelectTextArgsSchema = z
  .object({
    app: AppQuery,
    element_index: ElementIndex,
    snapshot_id: SnapshotId,
    text: z.string(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    selection_type: z.enum(SELECTION_TYPES).optional(),
  })
  .strict();
export type SelectTextArgs = z.infer<typeof SelectTextArgsSchema>;

export const SetValueArgsSchema = z
  .object({ app: AppQuery, element_index: ElementIndex, snapshot_id: SnapshotId, value: z.string() })
  .strict();
export type SetValueArgs = z.infer<typeof SetValueArgsSchema>;

export const TypeTextArgsSchema = z.object({ app: AppQuery, text: z.string() }).strict();
export type TypeTextArgs = z.infer<typeof TypeTextArgsSchema>;

export interface ActionArgsByName {
  readonly click: ClickArgs;
  readonly drag: DragArgs;
  readonly get_app_state: GetAppStateArgs;
  readonly list_apps: ListAppsArgs;
  readonly paste: PasteArgs;
  readonly perform_secondary_action: PerformSecondaryActionArgs;
  readonly press_key: PressKeyArgs;
  readonly scroll: ScrollArgs;
  readonly select_text: SelectTextArgs;
  readonly set_value: SetValueArgs;
  readonly type_text: TypeTextArgs;
}

export const ACTION_SCHEMAS: { readonly [N in ActionName]: z.ZodType<ActionArgsByName[N], z.ZodTypeDef, unknown> } = {
  click: ClickArgsSchema,
  drag: DragArgsSchema,
  get_app_state: GetAppStateArgsSchema,
  list_apps: ListAppsArgsSchema,
  paste: PasteArgsSchema,
  perform_secondary_action: PerformSecondaryActionArgsSchema,
  press_key: PressKeyArgsSchema,
  scroll: ScrollArgsSchema,
  select_text: SelectTextArgsSchema,
  set_value: SetValueArgsSchema,
  type_text: TypeTextArgsSchema,
};

export function isActionName(name: string): name is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(name);
}

/**
 * Validate one call's arguments. A schema failure is an `ActionError`, not a
 * `ZodError`: every caller of this layer handles one error type.
 */
export function parseActionArgs<N extends ActionName>(name: N, raw: unknown): ActionArgsByName[N] {
  const parsed = ACTION_SCHEMAS[name].safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  throw new ActionError('BAD_ARGS', `${name}: ${detail}`);
}
