/**
 * Every string this adapter uses to find something inside Feishu.
 *
 * Feishu ships two kinds of CSS class. Hashed ones (`_13e3ffd`, `c90c31ea`)
 * change every release and must never be selected on. Semantic hook classes do
 * not: `js-` names are JavaScript handles that never carry styling, and `a11y_`
 * names were added for accessibility on purpose. Only the second kind appears
 * below, and it all lives in this one file so a Feishu release that moves a
 * hook is a one-file change rather than a hunt through the adapter.
 *
 * Verified against Lark 7.x / Chromium 143 (`spikes/README.md`, section 3.2).
 */

export const FEISHU_BUNDLE_ID = 'com.bytedance.macos.feishu';
export const FEISHU_APP_PATH = '/Applications/Lark.app';

/**
 * Feishu renders each module in its own webview. The conversation list is
 * `messenger`; the open conversation is `messenger-chat`. Which ones exist
 * depends on the active sidebar tab, so they are resolved by title on every
 * read rather than cached.
 */
export const WEB_AREA = {
  role: 'AXWebArea',
  conversationList: 'messenger',
  openChat: 'messenger-chat',
} as const;

export const ROLE = {
  staticText: 'AXStaticText',
  textArea: 'AXTextArea',
  window: 'AXWindow',
  webArea: 'AXWebArea',
} as const;

/** DOM class hooks. Comments give what each one anchors. */
export const DOM_CLASS = {
  /** The conversation list container. */
  feedList: 'a11y_feed_main_list',
  /** One conversation row; its texts are [name, tag, date, preview]. */
  feedCard: 'a11y_feed_card_item',
  /** Header of the open conversation — the only place its title appears. */
  chatName: 'chatWindow_chatName',
  /** One message. Its `domId` is Feishu's real, monotonic message id. */
  messageItem: 'js-message-item',
  /** Body of an ordinary message. */
  messageBody: 'message-content-container',
  /** Body of a card message, which has no `message-content-container`. */
  cardBody: 'universal-card-root',
  /** The composer: an `AXTextArea` that is really a contenteditable. */
  composer: 'editor-kit-container',
} as const;

/**
 * Flags Feishu encodes in a message's class list. This is structured metadata
 * the app hands over for free — direction, chat kind and payload kind — and it
 * is why the adapter never has to guess who sent what.
 */
export const MESSAGE_FLAG = {
  self: 'message-self',
  notSelf: 'message-not-self',
  peerToPeer: 'message-is-p2p',
} as const;

/** Class suffix that names a message's payload kind (`text-message`, …). */
export const MESSAGE_KIND_SUFFIX = '-message';

/**
 * The composer's placeholder in a chat with yourself. Feishu writes
 * `发送给 <name>` everywhere else, so this exact string is the one piece of
 * evidence that distinguishes the self-chat from a conversation with a real
 * person. The send guard uses it and refuses to fall back to anything weaker.
 */
export const SELF_CHAT_PLACEHOLDER = '可以向自己发送文件或转发消息';

/**
 * AX notifications worth subscribing to. A new message arrives as a DOM
 * insertion under the message list, which surfaces as `AXValueChanged`
 * (measured at +60 ms in the spike); the other two are cheap insurance
 * against a Feishu build that routes the insertion differently.
 */
export const FEISHU_NOTIFICATIONS: readonly string[] = ['AXValueChanged', 'AXCreated', 'AXLayoutChanged'];

/**
 * Traversal limits. Message bodies sit at depth 30–45, so a shallow walk finds
 * an empty shell of `AXGroup`s and looks exactly like a broken AX tree.
 */
export const TREE_MAX_DEPTH = 45;
export const TREE_MAX_NODES = 12_000;

/** Modal windows Feishu opens in front of the main one, by title prefix. */
export const MODAL_WINDOW_PREFIX = 'ModalWebViewWidget';

/** The send key. Feishu has no send button — the composer advertises Enter. */
export const SEND_KEY = 'return';
export const SELECT_ALL_KEY = 'a';
export const DELETE_KEY = 'delete';
export const COMMAND_MODIFIER: readonly string[] = ['cmd'];
