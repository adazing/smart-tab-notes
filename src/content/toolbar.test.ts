// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSelectionToolbar } from './toolbar';
import { captureSelection, toolbarPosition } from './selection';
import { sendToBackground } from '../shared/messages';

vi.mock('../shared/messages', () => ({ sendToBackground: vi.fn(async () => ({ ok: true, data: { ok: true } })) }));

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
  dispose = installSelectionToolbar();
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
    dispose = installSelectionToolbar();
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
    expect(sendToBackground).toHaveBeenLastCalledWith('toolbar:action', expect.objectContaining({ text: 'Other words' }));
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

  it.each(['ask', 'note'] as const)('preserves selection while typing a %s', action => {
    select(); click(action === 'ask' ? 'Ask' : 'Note');
    const input = root().querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')!;
    expect(root().activeElement).toBe(input);
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(110);
    expect(panel().hidden).toBe(false);
    input.value = 'My message';
    root().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(sendToBackground).toHaveBeenLastCalledWith('toolbar:action', {
      action, text: 'Selected formatted text', url: location.href,
      [action === 'ask' ? 'question' : 'note']: 'My message',
    });
    expect(root().textContent).toContain(action === 'ask' ? 'Demo: question received' : 'has not been saved to storage');
  });

  it('highlights without changing formatted content or links', () => {
    const before = document.querySelector('#text')!.innerHTML;
    select(); click('Highlight');
    expect(document.querySelector('#text')!.innerHTML).toBe(before);
    expect(root().querySelectorAll('.highlight')).toHaveLength(1);
    expect(root().querySelector<HTMLElement>('.highlight')!.style.pointerEvents).toBe('');
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
