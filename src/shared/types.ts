/**
 * Shared data shapes used across the background worker, content scripts and
 * the side panel. Keep these free of any `chrome.*` calls so every part of
 * the extension can import them.
 */

/** The three top-level views in the side panel. */
export type SidePanelView = 'chat' | 'page' | 'library';

export const SIDE_PANEL_VIEWS: readonly SidePanelView[] = ['chat', 'page', 'library'] as const;

export const SIDE_PANEL_VIEW_LABELS: Record<SidePanelView, string> = {
  chat: 'Chat',
  page: 'This page',
  library: 'Library',
};

/** A tab, trimmed down to the fields the extension actually uses. */
export interface TabRef {
  tabId: number;
  windowId: number;
  /** Chrome tab group id, or -1 when the tab is not in a group. */
  groupId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  active: boolean;
  index: number;
  /** False for chrome://, the Web Store and other pages we cannot script. */
  accessible: boolean;
}

/** A Chrome tab group plus the ids of the tabs in it. */
export interface TabGroupRef {
  groupId: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
  tabIds: number[];
}

/**
 * What a content script can tell us about the page it runs in.
 * `text` is only filled in when the caller asks for it.
 */
export interface PageContext {
  url: string;
  title: string;
  /** Text content of the page body, truncated to the requested length. */
  text?: string;
  /** True when the body text was cut short. */
  truncated?: boolean;
  /** The user's current selection, if any. */
  selection: SelectionInfo | null;
}

/**
 * A highlighted range of text plus the words around it.
 *
 * `prefix` and `suffix` are what the W3C Web Annotation model calls a
 * TextQuoteSelector; they let us re-find the highlight after the page
 * changes. See the anchoring decision in the PRD.
 */
export interface SelectionInfo {
  text: string;
  prefix: string;
  suffix: string;
  url: string;
  title: string;
}

/** Generic acknowledgement for messages that have nothing to return. */
export interface Ack {
  ok: boolean;
  /** Set when `ok` is false. */
  reason?: string;
}

/** Payload for messages that take no arguments. */
export type Empty = Record<string, never>;
