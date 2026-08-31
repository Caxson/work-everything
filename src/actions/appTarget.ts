/**
 * Which running application an `app` argument means.
 *
 * Codex accepts a display name, a full app path or a bundle identifier, and
 * tells the model that when a display name fails it should retry with the
 * bundle identifier from `list_apps`. That retry is done here instead, once,
 * deterministically: whatever spelling comes in, what comes out is the entry
 * from the running-app list, and everything downstream addresses the app by
 * its bundle identifier and pid.
 *
 * Nothing in this file launches anything. Codex's runtime starts an app that
 * is not running; this daemon does not, because launching is the one thing
 * that cannot be done without taking the screen away from whoever is using
 * it. An app that is not running is an error that says so.
 */
import { ActionError } from './errors.js';

export interface RunningApp {
  readonly pid: number;
  readonly name: string;
  readonly bundleId: string;
  readonly activationPolicy?: string | undefined;
}

/** The canonical key for an app: what snapshots and waits are filed under. */
export function appKey(app: RunningApp): string {
  return app.bundleId;
}

const equalsCI = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `/Applications/Lark.app` → `Lark`. Anything else is returned unchanged. */
export function appNameFromPath(query: string): string {
  if (!query.includes('/')) return query;
  const last = query.replace(/\/+$/, '').split('/').pop() ?? query;
  return last.endsWith('.app') ? last.slice(0, -4) : last;
}

type Strategy = { readonly label: string; readonly match: (app: RunningApp, query: string) => boolean };

/**
 * Tried in order. Bundle identifier first because it is the only spelling
 * that is unambiguous, which is also why it is what this module hands back.
 */
const STRATEGIES: readonly Strategy[] = [
  { label: 'bundle identifier', match: (app, query) => equalsCI(app.bundleId, query) },
  { label: 'app path', match: (app, query) => query.includes('/') && equalsCI(app.name, appNameFromPath(query)) },
  { label: 'display name', match: (app, query) => equalsCI(app.name, query) },
];

/**
 * The running app a query names. Ambiguity is an error rather than a pick:
 * two apps answering to one display name is exactly when acting on the wrong
 * one does damage, and the caller has a precise spelling available.
 */
export function resolveApp(query: string, running: readonly RunningApp[]): RunningApp {
  for (const strategy of STRATEGIES) {
    const hits = running.filter((app) => strategy.match(app, query));
    const first = hits[0];
    if (first === undefined) continue;
    const distinct = new Set(hits.map((app) => app.bundleId));
    if (distinct.size > 1) {
      throw new ActionError(
        'APP_AMBIGUOUS',
        `'${query}' matches ${distinct.size} running apps by ${strategy.label} (${[...distinct].join(', ')}); name one by its bundle identifier`,
      );
    }
    return first;
  }
  throw new ActionError('APP_NOT_RUNNING', `no running application matches '${query}'. Running: ${summarize(running)}`);
}

function summarize(running: readonly RunningApp[]): string {
  if (running.length === 0) return 'none';
  const shown = running.slice(0, 8).map((app) => `${app.name} (${app.bundleId})`);
  return running.length > 8 ? `${shown.join(', ')}, …` : shown.join(', ');
}
