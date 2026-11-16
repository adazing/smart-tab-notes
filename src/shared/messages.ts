/**
 * The message bus.
 *
 * Every message between the content scripts, the background service worker
 * and the side panel goes through here. Adding a message means adding one
 * entry to `MessageContracts` below -- the request and response types then
 * flow through `send*` and `onMessage` automatically, and TypeScript will
 * tell you if a handler is missing or a payload is the wrong shape.
 *
 * HOW IT WORKS
 *   - Messages to the background worker or the side panel go over
 *     `chrome.runtime.sendMessage`, which every extension page receives.
 *     Each envelope therefore carries a `target`, and `onMessage` ignores
 *     anything not addressed to it.
 *   - Messages to a content script go over `chrome.tabs.sendMessage`, which
 *     needs a tab id.
 *   - Sends resolve to a `SendResult` instead of throwing. A closed side
 *     panel or a chrome:// tab with no content script is normal, not a bug,
 *     so callers get `{ ok: false, error }` and decide what to do.
 *
 * WHEN YOU ADD A MESSAGE: also add a row to the table in the README.
 */

import type { Annotation, AnnotationSource } from './storage-types';
import type {
  Ack,
  AnnotationTarget,
  Empty,
  ExplainResult,
  ExplainRun,
  PageContext,
  SelectionInfo,
  SidePanelView,
  TabContext,
  TabGroupRef,
  TabRef,
} from './types';
import { isFromExtensionPage } from './senders';

/** The three places a message can be sent to. */
export type Endpoint = 'background' | 'sidepanel' | 'content';

/**
 * Every message in the extension, as `kind: { request, response }`.
 *
 * Naming: `area:verb`, lower camel after the colon.
 */
export interface MessageContracts {
  /**
   * Toolbar Explain and Ask. The worker reads the sender's tab and other tabs
   * in its window (getTabContext), calls POST /explain and replies with the
   * answer. Failures come back as `{ ok: false, error }`, ready to show.
   */
  'explain:run': {
    request: ExplainRun;
    response: ExplainResult;
  };

  /** Health check. Useful for demos and for checking a content script is live. */
  'ping': {
    request: { from: Endpoint };
    response: { ok: true; endpoint: Endpoint; at: number };
  };

  /** All open tabs plus their groups. Backs the sidebar's tab list. */
  'tabs:list': {
    request: { currentWindowOnly?: boolean };
    response: { tabs: TabRef[]; groups: TabGroupRef[] };
  };

  /**
   * Readable text and ~500-token chunks for the given tabs, one result per
   * id in the same order. Unreadable tabs come back with a status, not an
   * error. See shared/tabContext.ts.
   */
  'tabs:getContext': {
    request: { tabIds: number[] };
    response: { contexts: TabContext[] };
  };

  /** The tab the user is looking at right now. */
  /**
   * The active tab of one window. Side panels pass their own `windowId`;
   * without it, the last focused window is used.
   */
  'tabs:getActive': {
    request: { windowId?: number };
    response: { tab: TabRef | null };
  };

  /** Bring a tab to the front. Backs "clicking a citation opens that tab". */
  'tabs:focus': {
    request: { tabId: number };
    response: Ack;
  };

  /** Sent by the background worker when the user switches or updates tabs. */
  'tabs:changed': {
    /** Every open side panel receives this; ignore it unless `windowId` is yours. */
    request: { activeTabId: number | null; windowId: number };
    response: Ack;
  };

  /**
   * Ask a content script for its page's URL, title and selection. For page
   * text use `tabs:getContext`, the one read path (Readability, hidden text
   * removed, editable fields never read).
   */
  'page:getContext': {
    request: Empty;
    response: PageContext;
  };

  /** Ask a content script for the user's current selection. */
  'page:getSelection': {
    request: Empty;
    response: { selection: SelectionInfo | null };
  };

  /** Fired by a content script after the user selects or clears text. */
  'page:selectionChanged': {
    /**
     * The worker stamps `tabId` and `windowId` before relaying to side panels.
     * Panels should ignore selections from tabs other than the one they show.
     */
    request: { selection: SelectionInfo | null; tabId?: number; windowId?: number };
    response: Ack;
  };

  /** Switch the side panel to a view, e.g. from the page's highlight popup. */
  'sidepanel:navigate': {
    request: { view: SidePanelView };
    response: Ack;
  };

  /** Sent by the side panel once it has mounted, so the worker can seed it. */
  'sidepanel:ready': {
    request: Empty;
    response: Ack;
  };

  /* ---------------------------------------------------------------- *
   * Saved notes and highlights
   *
   * Content scripts cannot use the extension's IndexedDB -- theirs
   * belongs to the page's origin -- so every read and write goes through
   * the worker, which owns `shared/storage.ts`.
   * ---------------------------------------------------------------- */

  /**
   * Save a highlight, with its note and its anchoring selectors, and the AI
   * explanation when it came from Explain or Ask. The worker creates or
   * restores the page record first, so the caller only has to know the URL
   * and title. Content scripts may only save to their own tab's page.
   */
  'annotations:save': {
    request: {
      url: string;
      title: string;
      /** The quote, for lists that show notes without the page open. */
      text: string;
      note?: string;
      target?: AnnotationTarget;
      explanation?: string;
      question?: string;
      sources?: AnnotationSource[];
    };
    response: { ok: boolean; annotation?: Annotation; reason?: string };
  };

  /** Every active note for one URL, oldest first. Empty for an unsaved page. */
  'annotations:list': {
    request: { url: string };
    response: { annotations: Annotation[]; reason?: string };
  };

  /**
   * Edit a note. `note: ''` clears the note. `explanation` (with `question`
   * and `sources`) attaches an AI answer, e.g. Explain from the note card.
   */
  'annotations:update': {
    request: {
      id: string;
      note?: string;
      explanation?: string;
      question?: string;
      sources?: AnnotationSource[];
    };
    response: { ok: boolean; annotation?: Annotation; reason?: string };
  };

  /**
   * Sent by the worker after a page's notes change (saved, edited, deleted),
   * to side panels and to tabs showing that page, so lists and highlights
   * stay in step wherever the change came from.
   */
  'annotations:changed': {
    request: { url: string };
    response: Ack;
  };

  /**
   * Page -> worker: the user clicked a note's highlighted text. The worker
   * opens the side panel if it can and tells it with `annotations:focused`.
   */
  'annotations:focus': {
    request: { id: string };
    response: Ack;
  };

  /** Worker -> side panels: show this note in the Notes view (scroll to it, flash it). */
  'annotations:focused': {
    request: { id: string; tabId: number; windowId: number };
    response: Ack;
  };

  /** Side panel -> page: scroll to a saved highlight, flash it and open its card. */
  'annotations:reveal': {
    request: { id: string };
    response: Ack;
  };

  /** Soft-delete one note, undrawing its highlight. */
  'annotations:delete': {
    request: { id: string };
    response: Ack;
  };

  /**
   * Record whether this visit could place the note's quote. Sent only when
   * the answer changed, and never advances `updatedAt`.
   */
  'annotations:anchorState': {
    request: { id: string; orphaned: boolean };
    response: Ack;
  };
}

export type MessageKind = keyof MessageContracts;
export type RequestOf<K extends MessageKind> = MessageContracts[K]['request'];
export type ResponseOf<K extends MessageKind> = MessageContracts[K]['response'];

/** Marks our messages so we ignore traffic from other extensions or libraries. */
const MARKER = '@smart-tab-notes/v1';

/** What actually travels over the wire. */
export interface Envelope<K extends MessageKind = MessageKind> {
  marker: typeof MARKER;
  kind: K;
  target: Endpoint;
  payload: RequestOf<K>;
  sentAt: number;
}

/** Sends never throw; they resolve to this. */
export type SendResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** A handler for one message kind. May be async. */
export type MessageHandler<K extends MessageKind> = (
  payload: RequestOf<K>,
  sender: chrome.runtime.MessageSender,
) => ResponseOf<K> | Promise<ResponseOf<K>>;

/** Call to stop listening. */
export type Unsubscribe = () => void;

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Envelope).marker === MARKER
  );
}

function envelope<K extends MessageKind>(
  kind: K,
  target: Endpoint,
  payload: RequestOf<K>,
): Envelope<K> {
  return { marker: MARKER, kind, target, payload, sentAt: Date.now() };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown messaging error';
}

/**
 * True when a failed send just means nobody was listening -- a closed side
 * panel, a tab with no content script. Callers usually want to ignore these.
 */
export function isNoReceiverError(error: string): boolean {
  return (
    error.includes('Receiving end does not exist') ||
    error.includes('Could not establish connection') ||
    error.includes('message port closed') ||
    // A content script left over after the extension reloaded.
    error.includes('Extension context invalidated')
  );
}

async function dispatch<K extends MessageKind>(
  message: Envelope<K>,
  tabId?: number,
): Promise<SendResult<ResponseOf<K>>> {
  try {
    const response =
      tabId === undefined
        ? await chrome.runtime.sendMessage(message)
        : await chrome.tabs.sendMessage(tabId, message);

    if (response === undefined) {
      // A listener matched but returned nothing, or none matched at all.
      return { ok: false, error: 'No response for "' + message.kind + '"' };
    }
    return { ok: true, data: response as ResponseOf<K> };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** Send to the background service worker. */
export function sendToBackground<K extends MessageKind>(
  kind: K,
  payload: RequestOf<K>,
): Promise<SendResult<ResponseOf<K>>> {
  return dispatch(envelope(kind, 'background', payload));
}

/** Send to the side panel. Fails harmlessly when the panel is closed. */
export function sendToSidePanel<K extends MessageKind>(
  kind: K,
  payload: RequestOf<K>,
): Promise<SendResult<ResponseOf<K>>> {
  return dispatch(envelope(kind, 'sidepanel', payload));
}

/** Send to the content script in one tab. */
export function sendToTab<K extends MessageKind>(
  tabId: number,
  kind: K,
  payload: RequestOf<K>,
): Promise<SendResult<ResponseOf<K>>> {
  return dispatch(envelope(kind, 'content', payload), tabId);
}

/**
 * Fire-and-forget version of the sends above: no response, and a missing
 * receiver is swallowed. Use it for events like `page:selectionChanged`.
 */
export async function notify<K extends MessageKind>(
  target: Exclude<Endpoint, 'content'>,
  kind: K,
  payload: RequestOf<K>,
): Promise<void> {
  const result = await dispatch(envelope(kind, target, payload));
  if (!result.ok && !isNoReceiverError(result.error)) {
    console.warn('[smart-tab-notes] notify ' + kind + ' failed:', result.error);
  }
}

/**
 * Listen for one message kind addressed to this endpoint.
 *
 *   const off = onMessage('background', 'tabs:focus', async ({ tabId }) => {
 *     await chrome.tabs.update(tabId, { active: true });
 *     return { ok: true };
 *   });
 *
 * Returns an unsubscribe function. Register at most one handler per
 * (endpoint, kind) pair: a second one would race the first to respond.
 */
export function onMessage<K extends MessageKind>(
  endpoint: Endpoint,
  kind: K,
  handler: MessageHandler<K>,
): Unsubscribe {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (!isEnvelope(message)) return false;
    if (message.target !== endpoint || message.kind !== kind) return false;
    // runtime.sendMessage reaches every extension page, so a content script
    // could post straight to the side panel and skip the background's checks.
    // Panels only listen to the extension itself.
    if (endpoint === 'sidepanel' && !isFromExtensionPage(sender, chrome.runtime.getURL(''))) return false;

    void Promise.resolve(handler(message.payload as RequestOf<K>, sender))
      .then(sendResponse)
      .catch((error: unknown) => {
        console.error('[smart-tab-notes] handler for "' + kind + '" threw:', error);
        // Reply anyway so the sender is not left waiting on a dead channel.
        sendResponse(undefined);
      });

    // Keep the message channel open for the async reply.
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * Register several handlers for one endpoint at once.
 *
 *   registerHandlers('background', {
 *     'tabs:list': listTabs,
 *     'tabs:focus': focusTab,
 *   });
 */
export function registerHandlers(
  endpoint: Endpoint,
  handlers: { [K in MessageKind]?: MessageHandler<K> },
): Unsubscribe {
  const offs = (Object.keys(handlers) as MessageKind[]).map((kind) =>
    onMessage(endpoint, kind, handlers[kind] as MessageHandler<typeof kind>),
  );
  return () => offs.forEach((off) => off());
}
