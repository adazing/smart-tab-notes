// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSelectionToolbar } from './toolbar';
import { captureSelection, toolbarPosition } from './selection';
import { sendToBackground } from '../shared/messages';

vi.mock('../shared/messages', () => ({ sendToBackground: vi.fn() }));

/** What the worker answers per message kind, unless a test overrides it. */
function workerReplies(kind: string): unknown {
  if (kind === 'explain:run') {
    return { ok: true, data: { ok: true, explanation: 'It means X.', sources: [{ tabId: 7, title: 'Other tab', url: 'https://other.example/' }] } };
  }
  return { ok: true, data: { ok: true } };
}

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
  vi.mocked(sendToBackground).mockImplementation((async (kind: string) => workerReplies(kind)) as never);
  dispose = installSelectionToolbar(annotations, { requireUserGesture: false });
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
    expect(root().querySelectorAll('.actions button')).toHaveLength(3);
    dispose = installSelectionToolbar(annotations, { requireUserGesture: false });
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
    click('Note');
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
  it('offers Explain, Ask and Highlight: every saved note is a highlight', () => {
    select();
    expect([...root().querySelectorAll('.actions button')].map(b => b.textContent)).toEqual(['Explain', 'Ask', 'Note']);
  });

  it('explains, shows the answer and its sources, then saves it as a highlight', async () => {
    select(); click('Explain');
    expect(root().textContent).toContain('Explaining…');
    expect(sendToBackground).toHaveBeenCalledWith('explain:run', { text: 'Selected formatted text', url: location.href });
    await vi.advanceTimersByTimeAsync(0);
    expect(root().querySelector('.answer')!.textContent).toBe('It means X.');
    expect(root().textContent).toContain('From your tabs: Other tab');
    click('Save as note');
    expect(annotations.save).toHaveBeenLastCalledWith({
      range: expect.any(Range), text: 'Selected formatted text', explanation: 'It means X.',
      sources: [{ title: 'Other tab', url: 'https://other.example/' }], editNote: false,
    });
    await vi.advanceTimersByTimeAsync(1);
    // The drawn highlight and its card are the confirmation, so the toolbar goes.
    expect(panel().hidden).toBe(true);
  });

  it('asks a question, keeping the selection while typing, and saves the answer with it', async () => {
    select(); click('Ask');
    const input = root().querySelector('input')!;
    expect(root().activeElement).toBe(input);
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(110);
    expect(panel().hidden).toBe(false);
    input.value = 'Why?';
    root().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(sendToBackground).toHaveBeenLastCalledWith('explain:run', {
      text: 'Selected formatted text', url: location.href, question: 'Why?',
    });
    expect(root().textContent).toContain('Answering…');
    await vi.advanceTimersByTimeAsync(0);
    expect(root().textContent).toContain('Q: Why?');
    click('Save as note');
    expect(annotations.save).toHaveBeenLastCalledWith(expect.objectContaining({ question: 'Why?', explanation: 'It means X.' }));
  });

  it('saves a plain highlight with its note box open, and then gets out of the way', async () => {
    select(); click('Note');
    expect(root().textContent).toContain('Saving');
    expect(annotations.save).toHaveBeenLastCalledWith({
      range: expect.any(Range), text: 'Selected formatted text', editNote: true,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(panel().hidden).toBe(true);
  });

  it('says a highlight was saved even when the page cannot show it', async () => {
    annotations.save.mockResolvedValueOnce({ ok: true, drawn: false });
    select(); click('Note');
    await vi.advanceTimersByTimeAsync(1);
    expect(root().textContent).toContain('Saved to your notes');
    expect(panel().hidden).toBe(false);
  });

  it('reports a failed save instead of pretending it worked', async () => {
    annotations.save.mockResolvedValueOnce({ ok: false, reason: 'Storage is unavailable.' } as never);
    select(); click('Note');
    await vi.advanceTimersByTimeAsync(1);
    expect(root().textContent).toContain('Storage is unavailable.');
  });

  it('shows the worker error with a retry', async () => {
    vi.mocked(sendToBackground).mockResolvedValueOnce({ ok: true, data: { ok: false, error: "Can't reach the server." } });
    select(); click('Explain');
    await vi.advanceTimersByTimeAsync(0);
    expect(root().querySelector('[role=alert]')!.textContent).toBe("Can't reach the server.");
    click('Try again');
    await vi.advanceTimersByTimeAsync(0);
    expect(root().querySelector('.answer')!.textContent).toBe('It means X.');
  });

  it('drops an answer that arrives after the user selected something else', async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(sendToBackground).mockReturnValueOnce(new Promise(resolve => { answer = resolve; }) as never);
    select(); click('Explain');
    select('#other');
    answer(workerReplies('explain:run'));
    await vi.advanceTimersByTimeAsync(0);
    expect(root().querySelector('.answer')).toBeNull();
    expect(root().querySelector<HTMLElement>('.detail')!.hidden).toBe(true);
  });

  it('ignores scripted clicks: Explain, Ask and Highlight need a real user input', async () => {
    dispose();
    dispose = installSelectionToolbar(annotations);
    select(); click('Explain'); click('Note');
    click('Ask');
    root().querySelector('input')!.value = 'Injected';
    root().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sendToBackground).not.toHaveBeenCalled();
    expect(annotations.save).not.toHaveBeenCalled();
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

  it('says messaging is unavailable when the worker cannot be reached', async () => {
    vi.mocked(sendToBackground).mockResolvedValueOnce({ ok: false, error: 'Extension context invalidated.' });
    select(); click('Explain');
    await vi.advanceTimersByTimeAsync(0);
    expect(root().textContent).toContain('Reload this page to use it here');
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
