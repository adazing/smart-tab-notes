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
  page: 'Notes',
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
  /**
   * False when Chrome has unloaded (discarded) the tab to save memory, or it
   * has not loaded since the browser restarted. Only the title and URL are
   * known until the user visits it.
   */
  loaded: boolean;
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

/** What a content script can tell us about the page it runs in. */
export interface PageContext {
  url: string;
  title: string;
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

/* ------------------------------------------------------------------ *
 * Page text extraction (getTabContext)
 * ------------------------------------------------------------------ */

/** One heading or paragraph-like block of readable page text, in order. */
export interface TextBlock {
  kind: 'heading' | 'text';
  text: string;
  /** 1-6 for headings. */
  level?: number;
}

/** What the injected extractor returns for one page. */
export interface ExtractedPage {
  title: string;
  url: string;
  /** Readable text, blocks joined by blank lines. */
  text: string;
  wordCount: number;
  blocks: TextBlock[];
  /**
   * `stack-exchange` on Stack Overflow and other Stack Exchange sites,
   * `readability` normally, `visible-text` when Readability found no article.
   */
  extractor: 'stack-exchange' | 'readability' | 'visible-text';
  /** True when the text hit the size cap and was cut short. */
  truncated: boolean;
}

/** About 500 tokens of page text, the unit we send to the AI and cite. */
export interface TextChunk {
  /** Unique across tabs: `t<tabId>-c<index>`. */
  id: string;
  index: number;
  /** Nearest heading above the chunk's first block, or '' if none. */
  heading: string;
  text: string;
  /** Rough token count (characters / 4). */
  tokenEstimate: number;
}

/**
 * Why a tab did or did not yield text.
 *   ok          text extracted
 *   not_loaded  tab is discarded or never loaded; only title and URL
 *   restricted  chrome://, the Web Store and other pages we cannot script
 *   pdf         Chrome's PDF viewer; not supported yet
 *   error       the tab is gone, or injection or extraction failed
 */
export type TabContextStatus = 'ok' | 'not_loaded' | 'restricted' | 'pdf' | 'error';

/** Everything getTabContext knows about one tab. */
export interface TabContext {
  tabId: number;
  title: string;
  url: string;
  groupId: number;
  loaded: boolean;
  status: TabContextStatus;
  /** Set when status is `error`. */
  error?: string;
  /** Empty unless status is `ok`. */
  text: string;
  wordCount: number;
  chunks: TextChunk[];
  extractor: ExtractedPage['extractor'] | null;
  truncated: boolean;
}

/** Generic acknowledgement for messages that have nothing to return. */
export interface Ack {
  ok: boolean;
  /** Set when `ok` is false. */
  reason?: string;
}

/** Payload for messages that take no arguments. */
export type Empty = Record<string, never>;

/* ------------------------------------------------------------------ *
 * Explain and Ask (toolbar -> background)
 * ------------------------------------------------------------------ */

/** Explain the selection, or answer `question` about it, for the sender's tab. */
export interface ExplainRun {
  text: string;
  /** The page the text was selected on. The worker refuses if the tab has moved on. */
  url: string;
  /** Ask: the user's question. Omit to explain. */
  question?: string;
}

/** Another open tab an explanation drew on. */
export interface ExplainSource {
  tabId: number;
  title: string;
  url: string;
}

export type ExplainResult =
  | { ok: true; explanation: string; sources: ExplainSource[] }
  | { ok: false; error: string };


/* ------------------------------------------------------------------ *
 * Anchoring saved notes to page text (W3C Web Annotation selectors)
 * ------------------------------------------------------------------ */

/**
 * The quote and the text around it, as in the W3C Web Annotation model's
 * TextQuoteSelector. `prefix`/`suffix` are what let us re-find the quote
 * when the page has changed, and tell two copies of the same sentence
 * apart.
 *
 * All three strings come from the normalized page text built by
 * `content/textIndex.ts`, not from `Selection.toString()`: runs of
 * whitespace are collapsed to one space so re-indented markup still
 * matches.
 */
export interface TextQuoteSelector {
  /** The highlighted text itself. */
  exact: string;
  /** Up to ANCHOR_CONTEXT_CHARS characters immediately before `exact`. */
  prefix: string;
  /** Up to ANCHOR_CONTEXT_CHARS characters immediately after `exact`. */
  suffix: string;
}

/**
 * Character offsets into the normalized page text, as in the W3C model's
 * TextPositionSelector. Only a hint: we always confirm it against the
 * quote, because any edit above the highlight shifts it.
 */
export interface TextPositionSelector {
  /** Offset of the first character. */
  start: number;
  /** Offset one past the last character. */
  end: number;
}

/** Where one saved note lives: a page, plus both selectors for its quote. */
export interface AnnotationTarget {
  /** Normalized page URL the offsets and quote were taken from. */
  source: string;
  quote: TextQuoteSelector;
  position: TextPositionSelector;
}

/** How a saved note was placed on the page again. */
export type AnchorStrategy = 'position' | 'quote' | 'fuzzy';

/** A re-found quote: offsets into the normalized page text, and how. */
export interface AnchorMatch extends TextPositionSelector {
  strategy: AnchorStrategy;
  /** 1 for the exact strategies; 0-1 for `fuzzy`. */
  similarity: number;
}

/**
 * chrome.storage.session key: the note the user last clicked on a page, so a
 * side panel that opens because of that click can still show it.
 * Value: `{ id, tabId, windowId, at }`.
 */
export const FOCUSED_NOTE_KEY = 'focusedNote';
