/**
 * Content script. Runs in every http(s)/file page.
 *
 * It is deliberately passive: it does not scrape or send anything on its
 * own. It answers questions the side panel asks, and it reports the text
 * the user has deliberately selected. That matches the PRD decision that
 * tabs are never read silently.
 *
 * The highlight popup, the pinned annotations and the real W3C anchoring
 * get built on top of this.
 */

import { registerHandlers, notify } from '../shared/messages';
import type { PageContext, SelectionInfo } from '../shared/types';

const LOG = '[smart-tab-notes:content]';

/** How many characters either side of a highlight we keep for re-anchoring. */
const CONTEXT_CHARS = 120;

/** Default cap on how much page text we hand back. */
const DEFAULT_MAX_CHARS = 20_000;

/* ------------------------------------------------------------------ *
 * Reading the page
 * ------------------------------------------------------------------ */

/**
 * Describe the current selection, with the words around it.
 *
 * The prefix/suffix are a first pass at the TextQuoteSelector from the W3C
 * Web Annotation model. The anchoring ticket replaces this with something
 * that survives a changed page; until then it is enough to prove the
 * message bus carries real data.
 */
function describeSelection(): SelectionInfo | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const block =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
  const blockText = block?.textContent ?? '';
  const start = blockText.indexOf(text);

  const prefix =
    start > 0 ? blockText.slice(Math.max(0, start - CONTEXT_CHARS), start) : '';
  const suffix =
    start >= 0
      ? blockText.slice(start + text.length, start + text.length + CONTEXT_CHARS)
      : '';

  return { text, prefix, suffix, url: location.href, title: document.title };
}

function readPageContext(includeText: boolean, maxChars: number): PageContext {
  const context: PageContext = {
    url: location.href,
    title: document.title,
    selection: describeSelection(),
  };

  if (includeText) {
    const full = document.body?.innerText ?? '';
    context.text = full.slice(0, maxChars);
    context.truncated = full.length > maxChars;
  }

  return context;
}

/* ------------------------------------------------------------------ *
 * Message handlers
 * ------------------------------------------------------------------ */

registerHandlers('content', {
  'ping': async () => ({ ok: true, endpoint: 'content', at: Date.now() }),

  'page:getContext': async ({ includeText = false, maxChars = DEFAULT_MAX_CHARS }) =>
    readPageContext(includeText, maxChars),

  'page:getSelection': async () => ({ selection: describeSelection() }),
});

/* ------------------------------------------------------------------ *
 * Selection events
 * ------------------------------------------------------------------ */

let selectionTimer: number | undefined;
let lastReported: string | null = null;

/**
 * `selectionchange` fires on every mouse move during a drag, so wait for
 * the user to settle before telling anyone.
 */
function onSelectionChange(): void {
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => {
    const selection = describeSelection();
    const key = selection ? selection.text : null;
    if (key === lastReported) return;
    lastReported = key;
    void notify('background', 'page:selectionChanged', { selection });
  }, 250);
}

document.addEventListener('selectionchange', onSelectionChange);

console.debug(LOG, 'ready on', location.href);
