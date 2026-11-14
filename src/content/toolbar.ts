import styles from './toolbar.css?inline';
import { sendToBackground } from '../shared/messages';
import type { ToolbarAction } from '../shared/types';
import { captureSelection, toolbarPosition, type SelectionSnapshot } from './selection';
import { createHighlights } from './highlights';

const HOST_ID = 'smart-tab-notes-selection-toolbar';
let uninstall: (() => void) | undefined;

/** One lifecycle per content-script instance. Reinitialization removes old listeners. */
export function installSelectionToolbar(): () => void {
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
  const highlights = createHighlights(root);
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
  let explanationTimer: number | undefined;
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
    window.clearTimeout(explanationTimer);
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

  async function report(payload: ToolbarAction): Promise<void> {
    const result = await sendToBackground('toolbar:action', payload);
    if (!result.ok && !disposed && snapshot?.text === payload.text && snapshot.url === payload.url) {
      status('Extension messaging is unavailable. Reload this page after reloading the extension.');
    }
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
      highlights.render();
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
    if (!snapshot) return;
    const selected = snapshot;
    closeDetail();
    status('Loading explanation… (Week 1 demo)');
    void report({ action: 'explain', text: selected.text, url: selected.url });
    explanationTimer = window.setTimeout(() => {
      if (snapshot === selected) status('Mock explanation: this selected passage introduces an idea. An AI explanation will replace this demo in Week 2.');
    }, 500);
  }, actions);

  function openEditor(action: 'ask' | 'note'): void {
    if (!snapshot) return;
    const selected = snapshot;
    closeDetail();
    detail.hidden = false;
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = action === 'ask' ? 'Question about this text' : 'Note about this text';
    const input = document.createElement(action === 'ask' ? 'input' : 'textarea');
    input.id = `smart-tab-notes-${action}`;
    input.required = true;
    label.htmlFor = input.id;
    form.append(label, input);
    const submit = button(action === 'ask' ? 'Ask question' : 'Save temporarily', () => {}, form);
    submit.type = 'submit';
    submit.className = 'submit';
    button('Cancel', () => closeDetail(true), form);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) { input.focus(); return; }
      const base = { text: selected.text, url: selected.url };
      void report(action === 'ask' ? { ...base, action, question: value } : { ...base, action, note: value });
      status(action === 'ask'
        ? 'Demo: question received. AI answers will be connected in Week 2.'
        : 'Note accepted for this demo only. It has not been saved to storage and will be lost when dismissed.');
    }, { signal });
    detail.append(form);
    position();
    input.focus();
  }

  button('Ask', () => openEditor('ask'), actions);
  button('Highlight', () => {
    if (!snapshot) return;
    highlights.add(snapshot.range);
    void report({ action: 'highlight', text: snapshot.text, url: snapshot.url });
    status('Highlighted temporarily on this page. Not saved to storage.');
  }, actions);
  button('Note', () => openEditor('note'), actions);

  // Preserve the page selection when clicking buttons, while allowing editor focus.
  root.addEventListener('mousedown', event => {
    if (event.target instanceof HTMLButtonElement) event.preventDefault();
  }, { signal });
  document.addEventListener('pointerdown', event => {
    if (event.composedPath().includes(host)) { interacting = true; return; }
    interacting = false;
    dragging = true;
    hide();
  }, { signal, capture: true });
  document.addEventListener('pointerup', () => { dragging = false; schedule(); }, { signal });
  document.addEventListener('pointercancel', () => { dragging = false; hide(); }, { signal });
  document.addEventListener('selectionchange', schedule, { signal });
  document.addEventListener('keyup', event => { if (event.key !== 'Escape') schedule(); }, { signal });
  document.addEventListener('keydown', event => {
    if (!event.composedPath().includes(host) && event.key !== 'Escape') interacting = false;
    if (event.key !== 'Escape' || panel.hidden) return;
    if (!detail.hidden) closeDetail(true);
    else hide();
    event.preventDefault();
    event.stopPropagation();
  }, { signal, capture: true });
  window.addEventListener('scroll', refresh, { signal, capture: true, passive: true });
  window.addEventListener('resize', refresh, { signal });
  window.visualViewport?.addEventListener('resize', refresh, { signal });
  window.visualViewport?.addEventListener('scroll', refresh, { signal });
  const observer = new ResizeObserver(refresh);
  observer.observe(document.documentElement);
  observer.observe(panel);
  function navigation(): void { hide(); highlights.clear(); url = location.href; }
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
    window.clearTimeout(explanationTimer);
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
