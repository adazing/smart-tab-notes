/**
 * Content script. Runs in every http(s)/file page.
 *
 * It is deliberately passive: it does not scrape or send anything on its
 * own. It answers questions the side panel asks, and it reports the text
 * the user has deliberately selected. That matches the PRD decision that
 * tabs are never read silently.
 *
 * The selection toolbar, the saved-note layer and the recap popup are
 * installed at the bottom of this file.
 */

import { touchesEditable } from './selection';
import { installAnnotationLayer } from './annotationLayer';
import { installRecapPopup } from './recapPopup';
import { buildTextIndex, offsetsFromRange } from './textIndex';
import { installSelectionToolbar } from './toolbar';
import { ANCHOR_CONTEXT_CHARS, quoteAt } from '../shared/anchor';
import { registerHandlers, notify } from '../shared/messages';
import type { PageContext, SelectionInfo } from '../shared/types';

const LOG = '[smart-tab-notes:content]';

/* ------------------------------------------------------------------ *
 * Reading the page
 * ------------------------------------------------------------------ */

/**
 * Describe the current selection, with the text around it.
 *
 * This is the same TextQuoteSelector the anchoring layer stores: the quote
 * and ANCHOR_CONTEXT_CHARS on each side, taken from the page's normalized
 * text so the side panel shows exactly the string a saved note would match
 * on. Falling back to the raw selection keeps the message useful on pages
 * the index cannot read, such as a selection inside another shadow root.
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
  const index = buildTextIndex();
  const position = offsetsFromRange(index, range);
  const quote = position
    ? quoteAt(index.text, position, ANCHOR_CONTEXT_CHARS)
    : { exact: text, prefix: '', suffix: '' };

  return {
    text: quote.exact,
    prefix: quote.prefix,
    suffix: quote.suffix,
    url: location.href,
    title: document.title,
  };
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

/* ------------------------------------------------------------------ *
 * Page UI
 *
 * The annotation layer goes first: the toolbar saves through it, and it
 * starts looking for this page's saved notes as soon as it is installed.
 * ------------------------------------------------------------------ */

const annotations = installAnnotationLayer();
installSelectionToolbar(annotations);
// Asks the worker whether anything is saved here, and offers a recap if so.
installRecapPopup();
