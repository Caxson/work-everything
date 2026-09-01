/**
 * Finding Feishu's parts inside one action-layer reading.
 *
 * The same knowledge `messages.ts` applies to a raw accessibility tree, applied
 * to the flat, indexed reading the action layer produces — because that is the
 * reading a write is bound to. Locating the composer in one tree and then
 * writing to an index from another is exactly the gap `snapshot_id` exists to
 * close, so the send path reads and acts on a single reading.
 *
 * Every selector still comes from `selectors.ts`. Nothing is matched on a
 * hashed class here either.
 */
import type { SnapshotElement } from '../../actions/snapshot.js';
import { subtreeElements, subtreeText, withDomClass } from '../../actions/snapshot.js';
import { DOM_CLASS, ROLE, WEB_AREA } from './selectors.js';

export interface OpenChat {
  readonly chatTitle: string;
  /** Absolute index of the composer, for `element_index`. */
  readonly composerIndex: number | undefined;
  /** What is currently typed in it, read from its text leaves. */
  readonly composerText: string;
}

/**
 * The open conversation, or `undefined` when none is on screen. Scoped to the
 * `messenger-chat` web area: Feishu renders the conversation list in a
 * separate webview, and both carry elements that would otherwise match.
 */
export function locateOpenChat(elements: readonly SnapshotElement[]): OpenChat | undefined {
  const area = elements.find((element) => element.role === ROLE.webArea && element.title === WEB_AREA.openChat);
  if (area === undefined) return undefined;

  const scope = subtreeElements(elements, area.index);
  const header = scope.find(withDomClass(DOM_CLASS.chatName));
  const composer = scope.find((element) => element.role === ROLE.textArea && withDomClass(DOM_CLASS.composer)(element));

  return {
    chatTitle: header === undefined ? '' : subtreeText(elements, header.index),
    composerIndex: composer?.index,
    composerText: composer === undefined ? '' : subtreeText(elements, composer.index),
  };
}
