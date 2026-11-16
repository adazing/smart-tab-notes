import styles from './toolbar.css?inline';
import { sendToBackground } from '../shared/messages';
import type { ExplainSource } from '../shared/types';
import { captureSelection, toolbarPosition, type SelectionSnapshot } from './selection';
import type { AnnotationLayer, SavedAnswer } from './annotationLayer';

const HOST_ID = 'smart-tab-notes-selection-toolbar';
const MESSAGING_UNAVAILABLE = 'The extension was updated. Reload this page to use it here.';
let uninstall: (() => void) | undefined;

/**
 * A toolbar action that reads other tabs or writes storage only runs within
 * this long after a real (trusted) pointer or key event inside the toolbar.
 */
const GESTURE_WINDOW_MS = 1_000;

export interface ToolbarOptions {
  /**
   * Default true. The toolbar lives in an open shadow root, so the page's own
   * scripts can call `.click()` on its buttons. Explain and Ask read the
   * user's other tabs and show the answer in the page, so they (and saving)
   * only run after a trusted user input inside the toolbar. Unit tests turn
   * this off because jsdom events are never trusted.
   */
  requireUserGesture?: boolean;
}

/**
 * One lifecycle per content-script instance. Reinitialization removes old listeners.
 *
 * The menu is Explain, Ask and Note. Every save goes through the
 * annotation layer, so every saved note is a highlight: the layer owns the
 * selectors, the highlight spans and the card that opens on click.
 */
export function installSelectionToolbar(annotations: AnnotationLayer, options: ToolbarOptions = {}): () => void {
  const requireUserGesture = options.requireUserGesture ?? true;
  uninstall?.();
  // Also clean up a previous injected script instance using a host-scoped event.
  document.getElementById(HOST_ID)?.dispatchEvent(new Event('smart-tab-notes:dispose'));
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.smartTabNotes = '';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  root.append(style);
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Selected text actions');
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Text actions');
  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.hidden = true;
  panel.append(actions, detail);
  root.append(panel);
  document.documentElement.append(host);

  const controller = new AbortController();
  const { signal } = controller;
  let snapshot: SelectionSnapshot | undefined;
  let dragging = false;
  let interacting = false;
  let timer: number | undefined;
  /** Bumped whenever the detail area changes, so late replies for old content are dropped. */
  let request = 0;
  /** performance.now() of the last trusted pointer or key event inside the toolbar. */
  let lastGesture = -Infinity;
  let frame = 0;
  let url = location.href;
  let disposed = false;

  function button(label: string, callback: () => void, parent: HTMLElement): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', callback, { signal });
    parent.append(element);
    return element;
  }

  function closeDetail(restoreFocus = false): void {
    request++;
    detail.hidden = true;
    detail.replaceChildren();
    if (restoreFocus) actions.querySelector('button')?.focus();
    position();
  }

  function hide(): void {
    window.clearTimeout(timer);
    panel.hidden = true;
    snapshot = undefined;
    interacting = false;
    closeDetail();
  }

  function status(text: string): void {
    detail.hidden = false;
    detail.replaceChildren();
    const message = document.createElement('p');
    message.className = 'status';
    message.setAttribute('role', 'status');
    message.textContent = text;
    detail.append(message);
    button('Close', () => closeDetail(true), detail);
    position();
  }

  /**
   * Save a highlight, with the AI answer when it came from Explain or Ask.
   *
   * On success the toolbar's work is done: the annotation layer draws the
   * highlight and opens its card, which is both the confirmation and the
   * place to edit or delete the note. A failure stays here, because a user
   * must never be left thinking a note was saved when it was not.
   */
  async function persist(selected: SelectionSnapshot, answer?: SavedAnswer): Promise<void> {
    status('Saving…');
    const result = await annotations.save({
      range: selected.range,
      text: selected.text,
      ...(answer ?? {}),
      // A plain highlight opens its card ready for a note.
      editNote: answer === undefined,
    });
    if (disposed) return;
    if (result.ok && result.drawn !== false) {
      hide();
      return;
    }
    if (snapshot !== selected) {
      // The selection moved on while we waited; there is nowhere to put the
      // message, so leave it where it can still be found.
      console.warn('[smart-tab-notes] highlight not drawn:', result.reason ?? 'no anchor');
      return;
    }
    status(result.ok
      ? 'Saved to your notes. This page changed too much to draw it here.'
      : result.reason ?? 'Could not save this highlight.');
  }

  /** True when the user, not a page script, just interacted with the toolbar. */
  function userInitiated(): boolean {
    return !requireUserGesture || performance.now() - lastGesture <= GESTURE_WINDOW_MS;
  }

  function recordGesture(event: Event): void {
    if (event.isTrusted && event.composedPath().includes(host)) lastGesture = performance.now();
  }

  /** Show `children` in the detail area, replacing what was there. */
  function showDetail(...children: Node[]): void {
    detail.hidden = false;
    detail.replaceChildren(...children);
    position();
  }

  function paragraph(className: string, text: string, role?: string): HTMLParagraphElement {
    const element = document.createElement('p');
    element.className = className;
    element.textContent = text;
    if (role) element.setAttribute('role', role);
    return element;
  }

  function row(): HTMLDivElement {
    const element = document.createElement('div');
    element.className = 'row';
    return element;
  }

  /** Explain the selection, or answer `question` about it, then offer to save. */
  async function explain(selected: SelectionSnapshot, question?: string): Promise<void> {
    closeDetail();
    const mine = request;
    const loading = paragraph('status loading', question ? 'Answering…' : 'Explaining…', 'status');
    loading.setAttribute('aria-busy', 'true');
    const loadingRow = row();
    button('Cancel', () => closeDetail(true), loadingRow);
    showDetail(loading, loadingRow);

    const result = await sendToBackground('explain:run', {
      text: selected.text, url: selected.url, ...(question ? { question } : {}),
    });
    if (disposed || mine !== request || snapshot !== selected) return;
    if (!result.ok) { status(MESSAGING_UNAVAILABLE); return; }
    const answer = result.data;
    if (!answer.ok) {
      const actionsRow = row();
      button('Try again', () => { if (userInitiated()) void explain(selected, question); }, actionsRow);
      button('Close', () => closeDetail(true), actionsRow);
      showDetail(paragraph('error', answer.error, 'alert'), actionsRow);
      return;
    }
    showAnswer(selected, answer.explanation, answer.sources, question);
  }

  function showAnswer(selected: SelectionSnapshot, explanation: string, sources: ExplainSource[], question?: string): void {
    const children: Node[] = [];
    if (question) children.push(paragraph('question', `Q: ${question}`));
    children.push(paragraph('answer', explanation, 'status'));
    if (sources.length) {
      children.push(paragraph('sources', `From your tabs: ${sources.map(s => s.title || s.url).join(' · ')}`));
    }
    const actionsRow = row();
    const save = button('Save as note', () => {
      if (!userInitiated()) return;
      save.disabled = true;
      void persist(selected, { explanation, ...(question ? { question } : {}), sources: sources.map(({ title, url }) => ({ title, url })) });
    }, actionsRow);
    save.className = 'submit';
    button('Close', () => closeDetail(true), actionsRow);
    children.push(actionsRow);
    showDetail(...children);
  }

  function position(): void {
    if (!snapshot || panel.hidden) return;
    if (location.href !== snapshot.url || !snapshot.range.startContainer.isConnected ||
      !snapshot.range.endContainer.isConnected || snapshot.range.collapsed) { hide(); return; }
    const rect = snapshot.range.getBoundingClientRect();
    const viewport = window.visualViewport;
    const bounds = { width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
      left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 };
    if (rect.bottom < bounds.top || rect.top > bounds.top + bounds.height ||
      rect.right < bounds.left || rect.left > bounds.left + bounds.width) { hide(); return; }
    panel.style.maxWidth = `${Math.max(0, bounds.width - 16)}px`;
    panel.style.maxHeight = `${Math.max(0, bounds.height - 16)}px`;
    const pos = toolbarPosition(rect, panel.offsetWidth, panel.offsetHeight, bounds);
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
  }

  function refresh(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  }

  function readSelection(): void {
    if (dragging || interacting || root.activeElement) return;
    const next = captureSelection(host);
    if (!next) { hide(); return; }
    if (snapshot && snapshot.text === next.text && snapshot.url === next.url &&
      snapshot.range.startContainer === next.range.startContainer &&
      snapshot.range.startOffset === next.range.startOffset &&
      snapshot.range.endContainer === next.range.endContainer &&
      snapshot.range.endOffset === next.range.endOffset) { position(); return; }
    closeDetail();
    snapshot = next;
    panel.hidden = false;
    position();
  }

  function schedule(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(readSelection, 100);
  }

  button('Explain', () => {
    if (!snapshot || !userInitiated()) return;
    void explain(snapshot);
  }, actions);

  function openAsk(): void {
    if (!snapshot) return;
    const selected = snapshot;
    closeDetail();
    detail.hidden = false;
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = 'Question about this text';
    const input = document.createElement('input');
    input.id = 'smart-tab-notes-ask';
    input.required = true;
    label.htmlFor = input.id;
    form.append(label, input);
    const actionsRow = row();
    const submit = button('Ask question', () => {}, actionsRow);
    submit.type = 'submit';
    submit.className = 'submit';
    button('Cancel', () => closeDetail(true), actionsRow);
    form.append(actionsRow);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) { input.focus(); return; }
      if (!userInitiated()) return;
      void explain(selected, value);
    }, { signal });
    detail.append(form);
    position();
    input.focus();
  }

  button('Ask', () => openAsk(), actions);
  // Note highlights the text and opens its note box; left empty, it is a plain highlight.
  button('Note', () => {
    if (!snapshot || !userInitiated()) return;
    closeDetail();
    void persist(snapshot);
  }, actions);

  // Preserve the page selection when clicking buttons, while allowing editor focus.
  root.addEventListener('mousedown', event => {
    if (event.target instanceof HTMLButtonElement) event.preventDefault();
  }, { signal });
  document.addEventListener('pointerdown', event => {
    recordGesture(event);
    if (event.composedPath().includes(host)) { interacting = true; return; }
    interacting = false;
    dragging = true;
    hide();
  }, { signal, capture: true });
  document.addEventListener('pointerup', event => { recordGesture(event); dragging = false; schedule(); }, { signal });
  document.addEventListener('pointercancel', () => { dragging = false; hide(); }, { signal });
  document.addEventListener('selectionchange', schedule, { signal });
  document.addEventListener('keyup', event => { recordGesture(event); if (event.key !== 'Escape') schedule(); }, { signal });
  document.addEventListener('keydown', event => {
    recordGesture(event);
    if (!event.composedPath().includes(host) && event.key !== 'Escape') interacting = false;
    if (event.key !== 'Escape' || panel.hidden) return;
    if (!detail.hidden) closeDetail(true);
    else hide();
    // Only keep Escape from the page when it was pressed inside the toolbar.
    // Otherwise the page's own Escape handling (closing its dialogs) still runs.
    if (event.composedPath().includes(host)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { signal, capture: true });
  window.addEventListener('scroll', refresh, { signal, capture: true, passive: true });
  window.addEventListener('resize', refresh, { signal });
  window.visualViewport?.addEventListener('resize', refresh, { signal });
  window.visualViewport?.addEventListener('scroll', refresh, { signal });
  const observer = new ResizeObserver(refresh);
  observer.observe(document.documentElement);
  observer.observe(panel);
  function navigation(): void { hide(); url = location.href; }
  window.addEventListener('popstate', navigation, { signal });
  window.addEventListener('hashchange', navigation, { signal });
  // pushState/replaceState do not emit popstate. Poll URL only, never page text.
  const navigationTimer = window.setInterval(() => {
    if (url !== location.href) navigation();
  }, 300);

  function dispose(): void {
    disposed = true;
    controller.abort();
    observer.disconnect();
    window.clearTimeout(timer);
    window.clearInterval(navigationTimer);
    cancelAnimationFrame(frame);
    host.remove();
    if (uninstall === dispose) uninstall = undefined;
  }
  window.addEventListener('pagehide', event => {
    if (event.persisted) navigation();
    else dispose();
  }, { signal });
  host.addEventListener('smart-tab-notes:dispose', dispose, { signal });
  uninstall = dispose;
  schedule();
  return dispose;
}
