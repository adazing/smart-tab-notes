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
 * quote, the note, the AI explanation and the tabs it drew on, with Add or
 * Edit note, Explain (when there is no explanation yet) and Delete.
 *
 * The worker sends `annotations:changed` when this page's notes change
 * elsewhere (the side panel, another tab), and `annotations:reveal` when the
 * side panel asks to show one.
 *
 * All storage goes through the worker: a content script's IndexedDB
 * belongs to the page's origin, not to the extension.
 */

import styles from './annotations.css?inline';
import { findAnchor } from '../shared/anchor';
import { onMessage, sendToBackground } from '../shared/messages';
import { normalizeUrl } from '../shared/normalize-url';
import type { Annotation, AnnotationSource } from '../shared/storage-types';
import type { AnchorMatch } from '../shared/types';
import { highlightIdAt, paintPieces, unpaint } from './highlightSpans';
import { toolbarPosition } from './selection';
import { buildTextIndex, piecesFromOffsets, targetFromRange } from './textIndex';

const HOST_ID = 'smart-tab-notes-annotations';

/** How long to wait for the page to settle before re-anchoring. */
const MUTATION_DEBOUNCE = 400;

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

/** Card actions that read other tabs only run this soon after a real user input in the card. */
const GESTURE_WINDOW_MS = 1_000;

/** How long a highlight flashes when the side panel reveals it. */
const FLASH_MS = 1_600;

/** An AI answer saved with a highlight. */
export interface SavedAnswer {
  explanation: string;
  question?: string;
  sources?: AnnotationSource[];
}

export interface SaveRequest {
  /** The user's selection. Only read while this call runs. */
  range: Range;
  /** The selected text, used if the page is too odd to build selectors from. */
  text: string;
  note?: string;
  explanation?: string;
  question?: string;
  sources?: AnnotationSource[];
  /** Open the card with the note box ready, as after a plain Highlight. */
  editNote?: boolean;
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

/**
 * A failed message, in words the user can act on. After the extension is
 * reloaded or updated, a page opened earlier keeps its highlights but can no
 * longer reach the extension until the page is reloaded too.
 */
export function messagingProblem(error: string): string {
  return /context invalidated|Receiving end does not exist|Could not establish connection|message port closed/i.test(error)
    ? 'The extension was updated. Reload this page to keep editing your notes.'
    : error;
}

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
export function installAnnotationLayer(options: { requireUserGesture?: boolean } = {}): AnnotationLayer {
  const requireUserGesture = options.requireUserGesture ?? true;
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
  /** Open the confirmation card in note-editing mode. */
  let confirmEditing = false;
  /** The note whose card is waiting on an AI explanation. */
  let explainingId: string | null = null;
  /** Second click on Delete confirms. */
  let confirmingDelete = false;
  let lastGesture = -Infinity;
  /**
   * A card the user closed (Escape or Close) while the pointer was on its
   * highlight. Hovering doesn't reopen it until the pointer leaves; a click
   * still does.
   */
  let dismissedId: string | null = null;
  let pinned = false;
  let editing = false;
  let hoveringCard = false;
  let restoringFocus = false;
  let hideTimer: number | undefined;
  let anchorTimer: number | undefined;
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
   */
  function anchorPending(): void {
    if (disposed) return;

    // A busy page can take a highlight away under an open card. Remember
    // which note it was showing so it can be put back once the highlight is.
    let reopen: { id: string; pinned: boolean; editing?: boolean } | null = null;

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
    for (const [entry, match] of ordered) {
      const pieces = piecesFromOffsets(index, match.start, match.end);
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
        reopen = { id: entry.annotation.id, pinned: true, editing: confirmEditing };
        confirmEditing = false;
      }
    }

    if (reopen && (entries.get(reopen.id)?.spans.length ?? 0) > 0) {
      openCard(reopen.id, reopen.pinned, reopen.editing);
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

  function scheduleAnchor(delay = MUTATION_DEBOUNCE): void {
    window.clearTimeout(anchorTimer);
    anchorTimer = window.setTimeout(() => anchorPending(), delay);
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
    // restoreFocus means the user closed it on purpose (Escape or Close).
    if (restoreFocus) dismissedId = openId;
    const entry = openId === null ? undefined : entries.get(openId);
    card.hidden = true;
    card.replaceChildren();
    openId = null;
    pinned = false;
    editing = false;
    confirmingDelete = false;
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

    if (editing) {
      heading('Note', card);
      const form = document.createElement('form');
      const field = document.createElement('textarea');
      field.value = entry.annotation.note ?? '';
      field.setAttribute('aria-label', 'Note about this text');
      field.placeholder = 'Add a note (optional)';
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

    if (entry.annotation.note) {
      heading('Note', card);
      paragraph(entry.annotation.note, card);
    }

    if (explainingId === entry.annotation.id) {
      heading('Explanation', card);
      const loading = paragraph('Explaining…', card, true);
      loading.setAttribute('role', 'status');
    } else if (entry.annotation.explanation) {
      heading(entry.annotation.question ? 'Answer' : 'Explanation', card);
      if (entry.annotation.question) paragraph('Q: ' + entry.annotation.question, card).className = 'question';
      paragraph(entry.annotation.explanation, card);
      const sources = entry.annotation.sources ?? [];
      if (sources.length) {
        const line = paragraph('From your tabs: ', card, true);
        line.classList.add('sources');
        sources.forEach((source, index) => {
          if (index > 0) line.append(' · ');
          const link = document.createElement('a');
          link.href = source.url;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = source.title || source.url;
          line.append(link);
        });
      }
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    button(entry.annotation.note ? 'Edit note' : 'Write note', actions, () => {
      pinned = true;
      editing = true;
      renderCard(entry);
    });
    if (!entry.annotation.explanation && explainingId !== entry.annotation.id) {
      button('Explain', actions, () => void explainEntry(entry));
    }
    button(confirmingDelete ? 'Really delete?' : 'Delete', actions, () => {
      if (!confirmingDelete) {
        confirmingDelete = true;
        pinned = true;
        renderCard(entry);
        return;
      }
      void deleteNote(entry);
    }, true);
    button('Close', actions, () => closeCard(true), true);
    card.append(actions);
    position();
  }

  function openCard(id: string, pin: boolean, edit = false): void {
    const entry = entries.get(id);
    if (!entry || entry.spans.length === 0) return;
    window.clearTimeout(hideTimer);
    if (openId === id && !edit) {
      pinned = pinned || pin;
      position();
      return;
    }
    openId = id;
    pinned = pin || edit;
    editing = edit;
    confirmingDelete = false;
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
      status(result.ok ? result.data.reason ?? 'Could not save this note.' : messagingProblem(result.error));
      return;
    }
    entry.annotation = result.data.annotation;
    editing = false;
    if (openId === entry.annotation.id) renderCard(entry);
  }

  /** True when the user, not a page script, just interacted with the card. */
  function userInitiated(): boolean {
    return !requireUserGesture || performance.now() - lastGesture <= GESTURE_WINDOW_MS;
  }

  function recordGesture(event: Event): void {
    if (event.isTrusted && event.composedPath().includes(host)) lastGesture = performance.now();
  }

  /** Explain a saved highlight that has no explanation yet, and attach the answer. */
  async function explainEntry(entry: Entry): Promise<void> {
    // The card is in an open shadow root; a page script must not be able to
    // make us read the user's other tabs and print them here.
    if (!userInitiated()) return;
    const id = entry.annotation.id;
    explainingId = id;
    pinned = true;
    if (openId === id) renderCard(entry);
    const result = await sendToBackground('explain:run', { text: entry.annotation.text, url: location.href });
    explainingId = null;
    if (disposed || !entries.has(id)) return;
    const fail = (message: string): void => {
      if (openId !== id) return;
      renderCard(entry);
      status(message);
    };
    if (!result.ok) { fail(messagingProblem(result.error)); return; }
    if (!result.data.ok) { fail(result.data.error); return; }
    const saved = await sendToBackground('annotations:update', {
      id,
      explanation: result.data.explanation,
      sources: result.data.sources.map(({ title, url }) => ({ title, url })),
    });
    if (disposed) return;
    if (!saved.ok || !saved.data.ok || !saved.data.annotation) {
      fail(saved.ok ? saved.data.reason ?? 'Could not save the explanation.' : messagingProblem(saved.error));
      return;
    }
    entry.annotation = saved.data.annotation;
    if (openId === id) renderCard(entry);
  }

  /** Scroll to a highlight, flash it and open its card (the side panel asked). */
  function reveal(id: string): boolean {
    const entry = entries.get(id);
    const first = entry?.spans.find((span) => span.isConnected);
    if (!entry || !first) return false;
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    for (const span of entry.spans) {
      span.style.setProperty('box-shadow', '0 0 0 3px #2f6df6', 'important');
    }
    window.setTimeout(() => {
      for (const span of entry.spans) span.style.removeProperty('box-shadow');
    }, FLASH_MS);
    // Let the smooth scroll land before placing the card.
    window.setTimeout(() => { if (!disposed) openCard(id, true); }, 350);
    return true;
  }

  async function deleteNote(entry: Entry): Promise<void> {
    const result = await sendToBackground('annotations:delete', { id: entry.annotation.id });
    if (disposed) return;
    if (!result.ok || !result.data.ok) {
      status(result.ok ? result.data.reason ?? 'Could not delete this note.' : messagingProblem(result.error));
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
    // A note edited elsewhere (the side panel) shows its new text in an open
    // card straight away, unless the user is typing in that card.
    const open = openId === null ? undefined : entries.get(openId);
    if (open && !editing && explainingId === null) renderCard(open);
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
      ...(request.explanation !== undefined ? { explanation: request.explanation } : {}),
      ...(request.question !== undefined ? { question: request.question } : {}),
      ...(request.sources !== undefined ? { sources: request.sources } : {}),
    });
    if (disposed) return { ok: false, reason: 'The page went away before the note was saved.' };
    if (!result.ok) return { ok: false, reason: messagingProblem(result.error) };
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
    confirmEditing = request.editNote === true;
    anchorPending();
    return { ok: true, drawn: (entries.get(annotation.id)?.spans.length ?? 0) > 0 };
  }

  /* ---------------------------------------------------------------- *
   * Page events
   * ---------------------------------------------------------------- */

  document.addEventListener('mouseover', (event) => {
    const id = highlightIdAt(event.target);
    if (id !== dismissedId) dismissedId = null;
    if (id) { if (id !== dismissedId) openCard(id, false); }
    else if (!event.composedPath().includes(host)) scheduleHide();
  }, { signal });

  document.addEventListener('click', (event) => {
    const id = highlightIdAt(event.target);
    if (!id) return;
    dismissedId = null;
    openCard(id, true);
    // Show the same note in the side panel (opening it if the browser
    // allows). Only for a real click: a page script must not be able to pop
    // the panel open.
    if (event.isTrusted) void sendToBackground('annotations:focus', { id });
  }, { signal });

  document.addEventListener('focusin', (event) => {
    if (restoringFocus) return;
    const id = highlightIdAt(event.target);
    if (id) openCard(id, true);
  }, { signal });

  document.addEventListener('pointerdown', (event) => {
    recordGesture(event);
    if (event.composedPath().includes(host) || highlightIdAt(event.target)) return;
    closeCard();
  }, { signal, capture: true });

  document.addEventListener('pointerup', recordGesture, { signal, capture: true });
  document.addEventListener('keyup', recordGesture, { signal, capture: true });
  document.addEventListener('keydown', (event) => {
    recordGesture(event);
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

  // Notes changed elsewhere (side panel, another tab): re-read them.
  const offChanged = onMessage('content', 'annotations:changed', () => {
    void load();
    return { ok: true };
  });
  const offReveal = onMessage('content', 'annotations:reveal', ({ id }) => {
    return reveal(id) ? { ok: true } : { ok: false, reason: 'This highlight is not on the page right now.' };
  });
  signal.addEventListener('abort', () => { offChanged(); offReveal(); });

  void load();

  return { save, dispose };
}
