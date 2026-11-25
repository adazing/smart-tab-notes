/**
 * Saved notes on the page: putting them back, and showing them.
 *
 * On load this asks the worker for the notes saved against this URL, finds
 * each quote again with `shared/anchor.ts`, and wraps what it finds in
 * highlight spans. A quote it cannot find is not lost: the note is marked
 * orphaned in storage and left alone, and a later attempt can still place
 * it, which is what happens on pages that render their text after we run.
 *
 * Hovering, clicking or tabbing to a highlight opens a card with the
 * quote, the note, the AI explanation, and Edit and Delete.
 *
 * All storage goes through the worker: a content script's IndexedDB
 * belongs to the page's origin, not to the extension.
 */

import styles from './annotations.css?inline';
import { findAnchor } from '../shared/anchor';
import { sendToBackground } from '../shared/messages';
import { normalizeUrl } from '../shared/normalize-url';
import type { Annotation } from '../shared/storage-types';
import type { AnchorMatch } from '../shared/types';
import { highlightIdAt, paintPieces, unpaint } from './highlightSpans';
import { toolbarPosition } from './selection';
import { buildTextIndex, piecesFromOffsets, targetFromRange } from './textIndex';

const HOST_ID = 'smart-tab-notes-annotations';

/** How long to wait for the page to settle before re-anchoring. */
const MUTATION_DEBOUNCE = 400;

/**
 * The longest a run of page mutations may hold re-anchoring off. The
 * debounce waits for the page to settle; a page that never settles -- a
 * ticker, a carousel, a polling feed -- would otherwise reset it forever
 * and its notes would be neither drawn nor orphaned for the whole visit.
 */
const MAX_MUTATION_WAIT = 2_000;

/** Waits between the attempts that follow the first one, in milliseconds. */
const RETRY_DELAYS = [600, 1_600, 4_000];

/** Attempts before a quote we cannot find is called orphaned. */
const ORPHAN_AFTER_ATTEMPTS = 3;

/**
 * Attempts before we stop looking for a quote on this visit. Busy pages
 * mutate constantly, and rebuilding the page text for a note that is not
 * there is not worth the battery. A note that was drawn and then lost
 * starts counting again, so a page that rewrites its text still recovers.
 */
const MAX_ATTEMPTS = 8;

/** How long the card stays after the pointer leaves a highlight. */
const HOVER_GRACE = 300;

export interface SaveRequest {
  /** The user's selection. Only read while this call runs. */
  range: Range;
  /** The selected text, used if the page is too odd to build selectors from. */
  text: string;
  note?: string;
}

export interface SaveResult {
  ok: boolean;
  reason?: string;
  /** False when the note was stored but could not be drawn on this page. */
  drawn?: boolean;
}

export interface AnnotationLayer {
  /** Save a highlight for the current selection and draw it. */
  save(request: SaveRequest): Promise<SaveResult>;
  dispose(): void;
}

interface Entry {
  annotation: Annotation;
  spans: HTMLSpanElement[];
  match: AnchorMatch | null;
  /** Failed anchoring attempts since the note was last drawn. */
  attempts: number;
  /** What we last told the worker, so we only send changes. */
  reportedOrphan: boolean | null;
}

let uninstall: (() => void) | undefined;

/** The page URL in the form storage uses, so targets match saved pages. */
function source(): string {
  try {
    return normalizeUrl(location.href);
  } catch {
    return location.href;
  }
}

/**
 * One layer per content-script instance. Installing again disposes the
 * previous one, including a stale copy left by an injected script.
 */
export function installAnnotationLayer(): AnnotationLayer {
  uninstall?.();
  document.getElementById(HOST_ID)?.dispatchEvent(new Event('smart-tab-notes:dispose'));

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.smartTabNotes = '';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  const card = document.createElement('section');
  card.className = 'card';
  card.hidden = true;
  card.setAttribute('aria-label', 'Saved note');
  root.append(style, card);
  document.documentElement.append(host);

  const controller = new AbortController();
  const { signal } = controller;
  const entries = new Map<string, Entry>();

  let openId: string | null = null;
  /** A note just saved, whose card opens as soon as it is drawn. */
  let confirmId: string | null = null;
  let pinned = false;
  let editing = false;
  let hoveringCard = false;
  let restoringFocus = false;
  let hideTimer: number | undefined;
  let anchorTimer: number | undefined;
  /** When the open debounce window has to give way and run. */
  let anchorDeadline: number | null = null;
  let retries = 0;
  let frame = 0;
  let url = location.href;
  let disposed = false;

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  function undraw(entry: Entry): void {
    if (entry.spans.length === 0) return;
    unpaint(entry.spans);
    entry.spans = [];
    entry.match = null;
  }

  /** Tell the worker how this visit went, but only when the answer changed. */
  async function reportAnchorState(entry: Entry, orphaned: boolean): Promise<void> {
    if (entry.reportedOrphan === orphaned) return;
    const alreadyStored =
      entry.reportedOrphan === null && (entry.annotation.orphaned ?? false) === orphaned;
    entry.reportedOrphan = orphaned;
    entry.annotation = { ...entry.annotation, orphaned };
    if (alreadyStored) return;
    await sendToBackground('annotations:anchorState', { id: entry.annotation.id, orphaned });
  }

  /**
   * Try to place every note that is not currently drawn.
   *
   * Anchoring runs against one snapshot of the page text, and the notes are
   * drawn from the bottom of the page upwards: wrapping a highlight splits
   * the text nodes after its start, so going backwards keeps the offsets of
   * the notes still to come correct.
   *
   * That holds only while the quotes do not overlap. One quote inside
   * another lands in a text node the inner highlight has already split, so
   * the snapshot's offsets for the outer one point past the end of a node
   * that is now shorter. The index is rebuilt before such a quote is
   * painted. Wrapping text in a span does not change the normalized text —
   * a span is not a block boundary, and a split whitespace run still
   * collapses to one space — so the offsets found above stay valid, and the
   * rebuilt index resolves them against the DOM as it now is.
   */
  function anchorPending(): void {
    if (disposed) return;

    // A busy page can take a highlight away under an open card. Remember
    // which note it was showing so it can be put back once the highlight is.
    let reopen: { id: string; pinned: boolean } | null = null;

    const pending: Entry[] = [];
    for (const entry of entries.values()) {
      const drawn = entry.spans.length > 0 && entry.spans.every((span) => span.isConnected);
      if (drawn) continue;
      // The page replaced the text we were drawn into; start again.
      undraw(entry);
      if (openId === entry.annotation.id) {
        reopen = { id: openId, pinned };
        closeCard();
      }
      if (!entry.annotation.target) void reportAnchorState(entry, true);
      else if (entry.attempts < MAX_ATTEMPTS) pending.push(entry);
    }
    if (pending.length === 0) return;

    const index = buildTextIndex();
    const placed = new Map<Entry, AnchorMatch>();
    for (const entry of pending) {
      const match = findAnchor(index.text, entry.annotation.target!);
      if (match) placed.set(entry, match);
      else {
        entry.attempts += 1;
        if (entry.attempts >= ORPHAN_AFTER_ATTEMPTS) void reportAnchorState(entry, true);
      }
    }

    const ordered = [...placed.entries()].sort(([, a], [, b]) => b.start - a.start);
    const done: AnchorMatch[] = [];
    let current = index;
    for (const [entry, match] of ordered) {
      const overlaps = done.some((other) => match.start < other.end && other.start < match.end);
      if (overlaps) {
        const fresh = buildTextIndex();
        // A page that changed under us mid-pass invalidates the offsets
        // themselves, not just the nodes. Leave it to the next pass.
        if (fresh.text !== index.text) {
          entry.attempts += 1;
          continue;
        }
        current = fresh;
      }
      done.push(match);
      const pieces = piecesFromOffsets(current, match.start, match.end);
      const spans = paintPieces(pieces, {
        id: entry.annotation.id,
        approximate: match.strategy === 'fuzzy',
      });
      if (spans.length === 0) {
        entry.attempts += 1;
        continue;
      }
      entry.spans = spans;
      entry.match = match;
      entry.attempts = 0;
      void reportAnchorState(entry, false);
      // A page that was still settling when the note was saved draws it on a
      // later pass; its card is owed either way.
      if (confirmId === entry.annotation.id) {
        confirmId = null;
        reopen = { id: entry.annotation.id, pinned: true };
      }
    }

    if (reopen && (entries.get(reopen.id)?.spans.length ?? 0) > 0) {
      openCard(reopen.id, reopen.pinned);
    }

    // Our own wrapping is not a page change; do not re-enter on it.
    observer.takeRecords();

    const unresolved = [...entries.values()].some(
      (entry) => entry.spans.length === 0 && entry.attempts < MAX_ATTEMPTS,
    );
    if (unresolved && retries < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[retries] as number;
      retries += 1;
      scheduleAnchor(delay);
    }
  }

  /**
   * Re-anchor once the page has been quiet for `delay`.
   *
   * Mutations keep pushing that back, so the wait is capped: the first
   * schedule of a window sets a deadline and later ones cannot postpone the
   * run past it. A retry names its own longer wait and owns the timing, so
   * it is not capped -- it is waiting for a page that has not rendered yet,
   * not for one that will not sit still.
   */
  function scheduleAnchor(delay = MUTATION_DEBOUNCE): void {
    const now = Date.now();
    const capped = delay === MUTATION_DEBOUNCE;
    if (!capped) anchorDeadline = null;
    else if (anchorDeadline === null) anchorDeadline = now + MAX_MUTATION_WAIT;
    const wait = anchorDeadline === null
      ? delay
      : Math.max(0, Math.min(delay, anchorDeadline - now));
    window.clearTimeout(anchorTimer);
    anchorTimer = window.setTimeout(() => {
      anchorTimer = undefined;
      anchorDeadline = null;
      anchorPending();
    }, wait);
  }

  /* ---------------------------------------------------------------- *
   * The note card
   * ---------------------------------------------------------------- */

  function button(
    label: string, parent: HTMLElement, onClick: () => void, quiet = false,
  ): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (quiet) element.className = 'quiet';
    element.addEventListener('click', onClick, { signal });
    parent.append(element);
    return element;
  }

  function heading(text: string, parent: HTMLElement): void {
    const element = document.createElement('h2');
    element.textContent = text;
    parent.append(element);
  }

  function paragraph(text: string, parent: HTMLElement, muted = false): HTMLParagraphElement {
    const element = document.createElement('p');
    if (muted) element.className = 'muted';
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function status(message: string): void {
    const element = document.createElement('p');
    element.className = 'status';
    element.setAttribute('role', 'status');
    element.textContent = message;
    card.append(element);
    position();
  }

  function closeCard(restoreFocus = false): void {
    window.clearTimeout(hideTimer);
    const entry = openId === null ? undefined : entries.get(openId);
    card.hidden = true;
    card.replaceChildren();
    openId = null;
    pinned = false;
    editing = false;
    hoveringCard = false;
    const span = restoreFocus ? entry?.spans[0] : undefined;
    if (!span) return;
    // Focusing the highlight would otherwise reopen the card we just closed.
    restoringFocus = true;
    span.focus();
    restoringFocus = false;
  }

  /** The one-line explanation of how this note found its way back. */
  function anchorNote(entry: Entry): string | null {
    if (entry.match?.strategy !== 'fuzzy') return null;
    const percent = Math.round(entry.match.similarity * 100);
    return `The page has changed here. Matched about ${percent}% of the saved text.`;
  }

  function renderCard(entry: Entry): void {
    card.replaceChildren();

    const quote = document.createElement('blockquote');
    quote.className = 'quote';
    quote.textContent = entry.annotation.text;
    card.append(quote);

    const approximate = anchorNote(entry);
    if (approximate) paragraph(approximate, card, true);

    heading('Note', card);
    if (editing) {
      const form = document.createElement('form');
      const field = document.createElement('textarea');
      field.value = entry.annotation.note ?? '';
      field.setAttribute('aria-label', 'Note about this text');
      form.append(field);
      const actions = document.createElement('div');
      actions.className = 'actions';
      const submit = button('Save note', actions, () => {});
      submit.type = 'submit';
      button('Cancel', actions, () => {
        editing = false;
        renderCard(entry);
      }, true);
      form.append(actions);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void saveNote(entry, field.value.trim());
      }, { signal });
      card.append(form);
      position();
      field.focus();
      return;
    }

    if (entry.annotation.note) paragraph(entry.annotation.note, card);
    else paragraph('No note yet.', card, true);

    heading('Explanation', card);
    if (entry.annotation.explanation) paragraph(entry.annotation.explanation, card);
    else paragraph('No AI explanation saved for this highlight yet.', card, true);

    const actions = document.createElement('div');
    actions.className = 'actions';
    button(entry.annotation.note ? 'Edit note' : 'Add note', actions, () => {
      pinned = true;
      editing = true;
      renderCard(entry);
    });
    button('Delete', actions, () => void deleteNote(entry), true);
    button('Close', actions, () => closeCard(true), true);
    card.append(actions);
    position();
  }

  function openCard(id: string, pin: boolean): void {
    const entry = entries.get(id);
    if (!entry || entry.spans.length === 0) return;
    window.clearTimeout(hideTimer);
    if (openId === id) {
      pinned = pinned || pin;
      position();
      return;
    }
    openId = id;
    pinned = pin;
    editing = false;
    card.hidden = false;
    renderCard(entry);
  }

  function scheduleHide(): void {
    if (pinned || editing) return;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!hoveringCard && !pinned && !editing) closeCard();
    }, HOVER_GRACE);
  }

  function position(): void {
    if (card.hidden || openId === null) return;
    const entry = entries.get(openId);
    if (!entry) { closeCard(); return; }

    const viewport = window.visualViewport;
    const bounds = {
      width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
      left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
    };

    // The card goes beside the first piece of the highlight that is actually
    // on screen, which is not always the first piece: a quote can begin with
    // something the page parks off-canvas, such as Wikipedia's
    // screen-reader-only citation labels.
    const rect = entry.spans
      .filter((span) => span.isConnected)
      .map((span) => span.getBoundingClientRect())
      .find((box) => !(box.bottom < bounds.top || box.top > bounds.top + bounds.height ||
        box.right < bounds.left || box.left > bounds.left + bounds.width));
    if (!rect) { closeCard(); return; }

    card.style.maxWidth = `${Math.max(0, bounds.width - 16)}px`;
    card.style.maxHeight = `${Math.max(0, bounds.height - 16)}px`;
    const spot = toolbarPosition(rect, card.offsetWidth, card.offsetHeight, bounds);
    card.style.left = `${spot.left}px`;
    card.style.top = `${spot.top}px`;
  }

  function refresh(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  }

  /* ---------------------------------------------------------------- *
   * Storage round trips
   * ---------------------------------------------------------------- */

  async function saveNote(entry: Entry, note: string): Promise<void> {
    const result = await sendToBackground('annotations:update', { id: entry.annotation.id, note });
    if (disposed) return;
    if (!result.ok || !result.data.ok || !result.data.annotation) {
      status(result.ok ? result.data.reason ?? 'Could not save this note.' : result.error);
      return;
    }
    entry.annotation = result.data.annotation;
    editing = false;
    if (openId === entry.annotation.id) renderCard(entry);
  }

  async function deleteNote(entry: Entry): Promise<void> {
    const result = await sendToBackground('annotations:delete', { id: entry.annotation.id });
    if (disposed) return;
    if (!result.ok || !result.data.ok) {
      status(result.ok ? result.data.reason ?? 'Could not delete this note.' : result.error);
      return;
    }
    if (openId === entry.annotation.id) closeCard();
    undraw(entry);
    entries.delete(entry.annotation.id);
  }

  async function load(): Promise<void> {
    const result = await sendToBackground('annotations:list', { url: location.href });
    if (disposed) return;
    if (!result.ok) {
      console.debug('[smart-tab-notes] could not read saved notes:', result.error);
      return;
    }

    const saved = result.data.annotations ?? [];
    const keep = new Set(saved.map((annotation) => annotation.id));
    for (const [id, entry] of entries) {
      if (keep.has(id)) continue;
      if (openId === id) closeCard();
      undraw(entry);
      entries.delete(id);
    }
    for (const annotation of saved) {
      const existing = entries.get(annotation.id);
      if (existing) existing.annotation = annotation;
      else {
        entries.set(annotation.id, {
          annotation, spans: [], match: null, attempts: 0, reportedOrphan: null,
        });
      }
    }
    retries = 0;
    anchorPending();
  }

  async function save(request: SaveRequest): Promise<SaveResult> {
    const index = buildTextIndex();
    const target = targetFromRange(index, request.range, source());
    const result = await sendToBackground('annotations:save', {
      url: location.href,
      title: document.title,
      text: target?.quote.exact ?? request.text,
      ...(request.note !== undefined ? { note: request.note } : {}),
      ...(target !== null ? { target } : {}),
    });
    if (disposed) return { ok: false, reason: 'The page went away before the note was saved.' };
    if (!result.ok) return { ok: false, reason: result.error };
    if (!result.data.ok || !result.data.annotation) {
      return { ok: false, reason: result.data.reason ?? 'Could not save this note.' };
    }

    const annotation = result.data.annotation;
    entries.set(annotation.id, {
      annotation, spans: [], match: null, attempts: 0, reportedOrphan: false,
    });
    // Draw it by anchoring, not from the Range we were handed: the page may
    // have moved on while the write was in flight, and this is the same
    // path a later visit takes, so a note that draws now will draw then.
    // Opening the card is the confirmation: it shows what was saved, on the
    // highlight itself. The toolbar cannot do that job -- wrapping the text
    // collapses the selection it was positioned against.
    retries = 0;
    confirmId = annotation.id;
    anchorPending();
    return { ok: true, drawn: (entries.get(annotation.id)?.spans.length ?? 0) > 0 };
  }

  /* ---------------------------------------------------------------- *
   * Page events
   * ---------------------------------------------------------------- */

  document.addEventListener('mouseover', (event) => {
    const id = highlightIdAt(event.target);
    if (id) openCard(id, false);
    else if (!event.composedPath().includes(host)) scheduleHide();
  }, { signal });

  document.addEventListener('click', (event) => {
    const id = highlightIdAt(event.target);
    if (id) openCard(id, true);
  }, { signal });

  document.addEventListener('focusin', (event) => {
    if (restoringFocus) return;
    const id = highlightIdAt(event.target);
    if (id) openCard(id, true);
  }, { signal });

  document.addEventListener('pointerdown', (event) => {
    if (event.composedPath().includes(host) || highlightIdAt(event.target)) return;
    closeCard();
  }, { signal, capture: true });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || card.hidden) return;
    closeCard(true);
    event.preventDefault();
    event.stopPropagation();
  }, { signal, capture: true });

  card.addEventListener('pointerenter', () => {
    hoveringCard = true;
    window.clearTimeout(hideTimer);
  }, { signal });
  card.addEventListener('pointerleave', () => {
    hoveringCard = false;
    scheduleHide();
  }, { signal });

  window.addEventListener('scroll', refresh, { signal, capture: true, passive: true });
  window.addEventListener('resize', refresh, { signal });
  window.visualViewport?.addEventListener('resize', refresh, { signal });
  window.visualViewport?.addEventListener('scroll', refresh, { signal });

  // Pages that render or replace their text after we run get another go.
  const observer = new MutationObserver(() => {
    retries = 0;
    scheduleAnchor();
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
  });

  function navigated(): void {
    closeCard();
    for (const entry of entries.values()) undraw(entry);
    entries.clear();
    url = location.href;
    retries = 0;
    confirmId = null;
    window.clearTimeout(anchorTimer);
    anchorTimer = undefined;
    anchorDeadline = null;
    void load();
  }
  window.addEventListener('popstate', navigated, { signal });
  window.addEventListener('hashchange', navigated, { signal });
  // pushState and replaceState do not fire events. Poll the URL only.
  const navigationTimer = window.setInterval(() => {
    if (url !== location.href) navigated();
  }, 500);

  function dispose(): void {
    disposed = true;
    controller.abort();
    observer.disconnect();
    window.clearTimeout(hideTimer);
    window.clearTimeout(anchorTimer);
    anchorTimer = undefined;
    anchorDeadline = null;
    window.clearInterval(navigationTimer);
    cancelAnimationFrame(frame);
    for (const entry of entries.values()) undraw(entry);
    entries.clear();
    host.remove();
    if (uninstall === dispose) uninstall = undefined;
  }

  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) dispose();
  }, { signal });
  host.addEventListener('smart-tab-notes:dispose', dispose, { signal });
  uninstall = dispose;

  void load();

  return { save, dispose };
}
