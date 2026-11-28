/**
 * "You have notes here. See what you learned?"
 *
 * When a page the reader has notes on loads, this asks the worker what is
 * saved against the page's URL (`recap:check`) and, the first time in a
 * browser session, offers a recap in the corner of the page. Taking up the
 * offer (`recap:open`) opens the side panel's Notes view with the recap in
 * it; the worker decides what the recap says, because it owns the notes.
 *
 * The popup never reads the page and never shows a note's text: it is a
 * count and two buttons. Dismissing it is final for this page and session,
 * which the worker records when it answers the check -- so a reload does not
 * bring it back either.
 */

import styles from './recap.css?inline';
import { sendToBackground } from '../shared/messages';
import { normalizeUrl } from '../shared/normalize-url';
import { savedCount } from '../shared/recapText';
import { messagingProblem } from './annotationLayer';

const HOST_ID = 'smart-tab-notes-recap';

/** How long after a trusted input inside the popup "See recap" still counts. */
const GESTURE_WINDOW_MS = 1_000;

/** Give the page a moment to settle (and the worker to wake) before asking. */
const CHECK_DELAY_MS = 400;

export interface RecapPopup {
  dispose(): void;
}

export interface RecapPopupOptions {
  /**
   * Default true. The popup lives in an open shadow root, so page scripts
   * can click its buttons. Opening the side panel needs a real user gesture
   * anyway; this keeps a page from trying. Unit tests turn it off, because
   * jsdom events are never trusted.
   */
  requireUserGesture?: boolean;
}

let uninstall: (() => void) | undefined;

/** The page URL in the form storage uses, so the worker looks up the same page. */
function source(): string {
  try {
    return normalizeUrl(location.href);
  } catch {
    return location.href;
  }
}

/**
 * One popup per content-script instance. Installing again disposes the
 * previous one, including a stale copy left by an injected script.
 */
export function installRecapPopup(options: RecapPopupOptions = {}): RecapPopup {
  const requireUserGesture = options.requireUserGesture ?? true;
  uninstall?.();
  document.getElementById(HOST_ID)?.dispatchEvent(new Event('smart-tab-notes:dispose'));

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.smartTabNotes = '';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  const popup = document.createElement('section');
  popup.className = 'popup';
  popup.hidden = true;
  popup.setAttribute('aria-label', 'Your notes on this page');
  root.append(style, popup);
  document.documentElement.append(host);

  const controller = new AbortController();
  const { signal } = controller;
  let disposed = false;
  let opening = false;
  let lastGesture = -Infinity;
  /** The normalized URL already asked about, so each page is asked about once. */
  let url = source();
  let checkTimer: number | undefined;

  function button(label: string, parent: HTMLElement, onClick: (event: MouseEvent) => void, quiet = false): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (quiet) element.className = 'quiet';
    element.addEventListener('click', onClick, { signal });
    parent.append(element);
    return element;
  }

  function close(): void {
    popup.hidden = true;
    popup.replaceChildren();
    opening = false;
  }

  function status(message: string): void {
    const element = document.createElement('p');
    element.className = 'status';
    element.setAttribute('role', 'status');
    element.textContent = message;
    popup.append(element);
  }

  /** True when the user, not a page script, just pressed the button. */
  function userInitiated(event: Event): boolean {
    return !requireUserGesture || event.isTrusted || performance.now() - lastGesture <= GESTURE_WINDOW_MS;
  }

  async function open(event: MouseEvent): Promise<void> {
    if (!userInitiated(event) || opening) return;
    opening = true;
    const result = await sendToBackground('recap:open', { url: location.href });
    if (disposed) return;
    if (result.ok && result.data.ok) {
      close();
      return;
    }
    opening = false;
    status(result.ok ? result.data.reason ?? 'Could not open the recap.' : messagingProblem(result.error));
  }

  function render(noteCount: number, summaryCount: number): void {
    popup.replaceChildren();
    const count = document.createElement('p');
    count.className = 'count';
    count.textContent = `You have ${savedCount(noteCount, summaryCount)} here.`;
    const ask = document.createElement('p');
    ask.className = 'ask';
    ask.textContent = 'See what you learned?';
    const actions = document.createElement('div');
    actions.className = 'actions';
    popup.append(count, ask, actions);
    // A stable hook for the browser test, which cannot match on button text
    // inside a shadow root as reliably as on an attribute.
    button('See recap', actions, (event) => void open(event)).setAttribute('data-recap-open', '');
    button('Dismiss', actions, close, true).setAttribute('data-recap-dismiss', '');
    popup.hidden = false;
    // Nothing is focused: the reader came here to read, not to answer a dialog.
  }

  async function check(): Promise<void> {
    const asking = source();
    const result = await sendToBackground('recap:check', { url: location.href });
    if (disposed || asking !== source()) return;
    if (!result.ok) {
      console.debug('[smart-tab-notes] could not check for a recap:', result.error);
      return;
    }
    const { show, noteCount, summaryCount } = result.data;
    if (!show || noteCount + summaryCount === 0) return;
    render(noteCount, summaryCount);
  }

  function scheduleCheck(delay = CHECK_DELAY_MS): void {
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => {
      checkTimer = undefined;
      void check();
    }, delay);
  }

  /**
   * A single-page app moved to another page: that page gets its own offer.
   * Only a real change counts -- dismissing an offer must not bring the
   * question back a second later.
   */
  function navigated(): void {
    const now = source();
    if (now === url) return;
    url = now;
    close();
    scheduleCheck();
  }

  function recordGesture(event: Event): void {
    if (event.isTrusted && event.composedPath().includes(host)) lastGesture = performance.now();
  }

  document.addEventListener('pointerdown', recordGesture, { signal, capture: true });
  document.addEventListener('keyup', recordGesture, { signal, capture: true });
  document.addEventListener('keydown', (event) => {
    recordGesture(event);
    if (event.key !== 'Escape' || popup.hidden) return;
    close();
  }, { signal, capture: true });

  window.addEventListener('popstate', navigated, { signal });
  window.addEventListener('hashchange', navigated, { signal });
  // pushState and replaceState do not fire events. Poll the URL only.
  const navigationTimer = window.setInterval(navigated, 1_000);

  function dispose(): void {
    disposed = true;
    controller.abort();
    window.clearTimeout(checkTimer);
    window.clearInterval(navigationTimer);
    host.remove();
    if (uninstall === dispose) uninstall = undefined;
  }

  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) dispose();
  }, { signal });
  host.addEventListener('smart-tab-notes:dispose', dispose, { signal });
  uninstall = dispose;

  scheduleCheck();

  return { dispose };
}
