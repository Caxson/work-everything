/**
 * One error type for the whole action layer, with a machine-readable code.
 *
 * The codes exist so callers can decide whether to try again, and the
 * important one is `SCREEN_LOCKED`. A locked Mac makes every GUI app look
 * broken through the accessibility API: windows stop being addressable, trees
 * come back empty, and an executor that treats that as a transient fault
 * retries forever against something only a person can undo — and, worse,
 * invites a "restart the app" remedy for a machine that is working fine.
 * So locked is terminal here, by construction, not by convention.
 */
export const ACTION_ERROR_CODES = [
  /** Arguments failed their schema. */
  'BAD_ARGS',
  /** No driver claimed the target app. */
  'NO_DRIVER',
  /** The target app is not running. This layer never launches anything. */
  'APP_NOT_RUNNING',
  /** More than one running app answers to that name; name it precisely. */
  'APP_AMBIGUOUS',
  /** The `snapshot_id` is not the reading this app is currently on. */
  'STALE_SNAPSHOT',
  /** The index is not in the snapshot it was paired with. */
  'UNKNOWN_ELEMENT',
  /** The app's tree never became readable within the timeout. */
  'TREE_NOT_READY',
  /** The screen is locked. Terminal: only a person changes this. */
  'SCREEN_LOCKED',
  /** Accessibility permission has not been granted. Terminal. */
  'NOT_TRUSTED',
  /** The verified write path into web content is not available. Terminal. */
  'HYBRID_ROUTE_UNAVAILABLE',
  /** This driver cannot perform this action at all. Terminal. */
  'UNSUPPORTED_ACTION',
  /** A driver's transport is not connected. */
  'NOT_CONNECTED',
  /** Focus did not land, so nothing was typed. */
  'FOCUS_FAILED',
  /** Anything the driver reported that is not one of the above. */
  'DRIVER_ERROR',
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

/**
 * Codes where doing the same thing again cannot produce a different answer.
 * A caller that retries one of these is burning time against a wall.
 */
export const TERMINAL_ACTION_CODES: ReadonlySet<ActionErrorCode> = new Set<ActionErrorCode>([
  'BAD_ARGS',
  'NO_DRIVER',
  'APP_NOT_RUNNING',
  'APP_AMBIGUOUS',
  'STALE_SNAPSHOT',
  'UNKNOWN_ELEMENT',
  'SCREEN_LOCKED',
  'NOT_TRUSTED',
  'HYBRID_ROUTE_UNAVAILABLE',
  'UNSUPPORTED_ACTION',
]);

/** Whether trying the same call again could plausibly work. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ActionError)) return true;
  return !TERMINAL_ACTION_CODES.has(error.code);
}

/** The bridge's own code, when the thrown value carries one. */
function bridgeCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

const BRIDGE_CODE_MAP: Readonly<Record<string, ActionErrorCode>> = {
  SCREEN_LOCKED: 'SCREEN_LOCKED',
  NOT_TRUSTED: 'NOT_TRUSTED',
  not_trusted: 'NOT_TRUSTED',
  NO_SUCH_PID: 'APP_NOT_RUNNING',
  not_running: 'APP_NOT_RUNNING',
  tree_not_ready: 'TREE_NOT_READY',
  TREE_NOT_READY: 'TREE_NOT_READY',
  FOCUS_FAILED: 'FOCUS_FAILED',
};

/**
 * Translate whatever a driver's transport threw into one `ActionError`.
 *
 * `SCREEN_LOCKED` gets a message that says what to do about it, because the
 * person reading it in a log needs to know the daemon is not broken.
 */
export function toActionError(error: unknown, context: string): ActionError {
  if (error instanceof ActionError) return error;
  const code = bridgeCode(error);
  const mapped = BRIDGE_CODE_MAP[code];
  const detail = error instanceof Error ? error.message : String(error);
  if (mapped === 'SCREEN_LOCKED') {
    return new ActionError(
      'SCREEN_LOCKED',
      `${context}: the Mac is locked, so no window can be addressed. Nothing here will change until a person unlocks it — not retried.`,
    );
  }
  if (mapped !== undefined) return new ActionError(mapped, `${context}: ${detail}`);
  return new ActionError('DRIVER_ERROR', `${context}: ${detail}`);
}
