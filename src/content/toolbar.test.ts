// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSelectionToolbar } from './toolbar';
import { captureSelection, toolbarPosition } from './selection';
import { sendToBackground } from '../shared/messages';

vi.mock('../shared/messages', () => ({ sendToBackground: vi.fn(async () => ({ ok: true, data: { ok: true } })) }));

/**
 * The toolbar only asks the annotation layer to save; drawing the
 * highlight and the note card are that layer's own tests.
 */
const annotations = {
  save: vi.fn(async () => ({ ok: true, drawn: true })),
  dispose: vi.fn(),
};

let dispose: () => void;
const rectangle = { left: 100, right: 250, top: 100, bottom: 120, width: 150, height: 20 };

function root(): ShadowRoot { return document.querySelector('[data-smart-tab-notes]')!.shadowRoot!; }
function panel(): HTMLElement { return root().querySelector('.panel')!; }
function click(label: string): void {
  const button = [...root().querySelectorAll('button')].find(element => element.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  button.click();
}
function select(selector = '#text'): void {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(selector)!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  vi.advanceTimersByTime(110);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', window.clearTimeout);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: vi.fn(() => rectangle) });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: vi.fn(() => [rectangle]) });
  document.body.innerHTML = '<p id="text">Selected <a href="#">formatted text</a></p><p id="other">Other words</p><p id="blank">   </p><div contenteditable="true">Editable text</div>';
  dispose = installSelectionToolbar(annotations);
});

afterEach(() => {
  dispose();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('toolbar selection and lifecycle', () => {
  it('uses one shadow host and waits for dragging to end', () => {
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    select();
    expect(panel().hidden).toBe(true);
    document.dispatchEvent(new Event('pointerup'));
    vi.advanceTimersByTime(110);
    expect(panel().hidden).toBe(false);
    expect(root().querySelectorAll('.actions button')).toHaveLength(4);
    dispose = installSelectionToolbar(annotations);
    expect(document.querySelectorAll('[data-smart-tab-notes]')).toHaveLength(1);
  });

  it('ignores whitespace and editable selections', () => {
    select('#blank');
    expect(panel().hidden).toBe(true);
    select('[contenteditable]');
    expect(panel().hidden).toBe(true);
    expect(captureSelection(document.querySelector('[data-smart-tab-notes]')!)).toBeUndefined();
  });

  it('responds to keyboard selection, selection clearing, Escape, and outside clicks', () => {
    select();
    expect(panel().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel().hidden).toBe(true);
    select();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel().hidden).toBe(true);
    document.dispatchEvent(new Event('pointerup'));
    select();
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(110);
    expect(panel().hidden).toBe(true);
  });

  it('replaces stale popovers when different text is selected', () => {
    select(); click('Explain');
    select('#other');
    expect(root().querySelector<HTMLElement>('.detail')!.hidden).toBe(true);
    click('Highlight');
    expect(annotations.save).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Other words' }));
  });

  it('hides offscreen selections and removes listeners on disposal', () => {
    select();
    vi.mocked(Range.prototype.getBoundingClientRect).mockReturnValue({ ...rectangle, top: -200, bottom: -180 } as DOMRect);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20);
    expect(panel().hidden).toBe(true);
    dispose();
    select();
    expect(document.querySelector('[data-smart-tab-notes]')).toBeNull();
  });
});

describe('toolbar actions', () => {
  it('shows a loading explanation then a clearly mocked response', () => {
    select(); click('Explain');
    expect(root().textContent).toContain('Loading explanation');
    vi.advanceTimersByTime(500);
    expect(root().textContent).toContain('Mock explanation');
    expect(sendToBackground).toHaveBeenCalledWith('toolbar:action', {
      action: 'explain', text: 'Selected formatted text', url: location.href,
    });
  });

  it.each(['ask', 'note'] as const)('preserves selection while typing a %s', async action => {
    select(); click(action === 'ask' ? 'Ask' : 'Note');
    const input = root().querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')!;
    expect(root().activeElement).toBe(input);
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(110);
    expect(panel().hidden).toBe(false);
    input.value = 'My message';
    root().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    if (action === 'ask') {
      expect(sendToBackground).toHaveBeenLastCalledWith('toolbar:action', {
        action, text: 'Selected formatted text', url: location.href, question: 'My message',
      });
      expect(root().textContent).toContain('Demo: question received');
      return;
    }
    // A note is saved through the annotation layer, with the text snapshot.
    expect(annotations.save).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'Selected formatted text', note: 'My message',
    }));
    await vi.advanceTimersByTimeAsync(1);
    // The drawn highlight and its card are the confirmation, so the toolbar goes.
    expect(panel().hidden).toBe(true);
  });

  it('saves a highlight through the annotation layer and then gets out of the way', async () => {
    select(); click('Highlight');
    expect(root().textContent).toContain('Saving highlight');
    expect(annotations.save).toHaveBeenLastCalledWith({
      range: expect.any(Range), text: 'Selected formatted text',
    });
    // No second report of the same text to the worker.
    expect(sendToBackground).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(panel().hidden).toBe(true);
  });

  it('says a highlight was saved even when the page cannot show it', async () => {
    annotations.save.mockResolvedValueOnce({ ok: true, drawn: false });
    select(); click('Highlight');
    await vi.advanceTimersByTimeAsync(1);
    expect(root().textContent).toContain('Saved to your notes');
    expect(panel().hidden).toBe(false);
  });

  it('reports a failed save instead of pretending it worked', async () => {
    annotations.save.mockResolvedValueOnce({ ok: false, reason: 'Storage is unavailable.' } as never);
    select(); click('Highlight');
    await vi.advanceTimersByTimeAsync(1);
    expect(root().textContent).toContain('Storage is unavailable.');
  });

  it('lets Escape reach the page when focus is on the page, but not from inside the toolbar', () => {
    const pageSaw = vi.fn();
    document.body.addEventListener('keydown', pageSaw);
    select();
    const fromPage = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(fromPage);
    expect(panel().hidden).toBe(true);
    expect(pageSaw).toHaveBeenCalledTimes(1);
    expect(fromPage.defaultPrevented).toBe(false);

    select(); click('Ask');
    const input = root().querySelector('input')!;
    const fromToolbar = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true });
    input.dispatchEvent(fromToolbar);
    expect(fromToolbar.defaultPrevented).toBe(true);
    document.body.removeEventListener('keydown', pageSaw);
  });

  // Explain, not Highlight: saving a highlight no longer goes through
  // toolbar:action, so this is the action that still reports to the worker.
  it('shows the error when the worker answers but refuses', async () => {
    vi.mocked(sendToBackground).mockResolvedValueOnce({ ok: true, data: { ok: false, reason: 'not from a tab' } });
    select(); click('Explain');
    await vi.advanceTimersByTimeAsync(10);
    expect(root().textContent).toContain('Extension messaging is unavailable');
  });

  it('keeps the messaging error instead of replacing it with the mock explanation', async () => {
    vi.mocked(sendToBackground).mockResolvedValueOnce({ ok: false, error: 'Extension context invalidated.' });
    select(); click('Explain');
    await vi.advanceTimersByTimeAsync(600);
    expect(root().textContent).toContain('Extension messaging is unavailable');
    expect(root().textContent).not.toContain('Mock explanation');
  });

  it('Escape closes the editor first, then the toolbar', () => {
    select(); click('Ask');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel().hidden).toBe(false);
    expect(root().querySelector<HTMLElement>('.detail')!.hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel().hidden).toBe(true);
  });
});

describe('positioning', () => {
  it('prefers above, flips below, and clamps to the viewport', () => {
    const viewport = { width: 400, height: 300 };
    expect(toolbarPosition(rectangle, 200, 40, viewport)).toEqual({ left: 75, top: 52 });
    expect(toolbarPosition({ left: 0, right: 10, top: 0, bottom: 20 }, 200, 40, viewport)).toEqual({ left: 8, top: 28 });
    expect(toolbarPosition({ left: 390, right: 400, top: 290, bottom: 300 }, 200, 100, viewport)).toEqual({ left: 192, top: 182 });
  });
  it('supports narrow and offset visual viewports', () => {
    expect(toolbarPosition(rectangle, 130, 40, { width: 150, height: 150, left: 20, top: 10 }))
      .toEqual({ left: 32, top: 52 });
  });
});
