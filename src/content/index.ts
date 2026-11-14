/**
 * Content script. Runs in every http(s)/file page.
 *
 * It is deliberately passive: it does not scrape or send anything on its
 * own. It answers questions the side panel asks, and it reports the text
 * the user has deliberately selected. That matches the PRD decision that
 * tabs are never read silently.
 *
 * The selection toolbar is installed below. Persistent annotations and
 * robust W3C anchoring are separate tickets.
 */

import { touchesEditable } from './selection';
import { installSelectionToolbar } from './toolbar';
import { registerHandlers, notify } from '../shared/messages';
import type { PageContext, SelectionInfo } from '../shared/types';

const LOG = '[smart-tab-notes:content]';

/** How many characters either side of a highlight we keep for re-anchoring. */
const CONTEXT_CHARS = 120;


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
  // Text in inputs and editable regions (email drafts, chat boxes) is the
  // user's own writing: never report it, matching the toolbar.
  if (touchesEditable(range)) return null;
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

function readPageContext(): PageContext {
  return { url: location.href, title: document.title, selection: describeSelection() };
}

/* ------------------------------------------------------------------ *
 * Message handlers
 * ------------------------------------------------------------------ */

registerHandlers('content', {
  'ping': async () => ({ ok: true, endpoint: 'content', at: Date.now() }),

  'page:getContext': async () => readPageContext(),

  'page:getSelection': async () => ({ selection: describeSelection() }),
});

/* ------------------------------------------------------------------ *
 * Selection events
 * ------------------------------------------------------------------ */

let selectionTimer: number | undefined;
/** Text last sent (null = "no selection" was sent); undefined = nothing sent yet. */
let lastReported: string | null | undefined;

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

// The side panel clears its selection whenever the user switches tabs. When
// this tab comes back into view, report the current selection again, even if
// it is the same text as last time.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  lastReported = undefined;
  onSelectionChange();
});

console.debug(LOG, 'ready on', location.href);

installSelectionToolbar();
