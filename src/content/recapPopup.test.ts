// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRecapPopup, type RecapPopup } from './recapPopup';

/** The popup's only way out is sendToBackground, so that is what we fake. */
const bus = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../shared/messages', () => ({ sendToBackground: bus.send, onMessage: vi.fn(() => () => {}) }));

let popup: RecapPopup;
/** What `recap:check` answers. */
let saved: { show: boolean; noteCount: number; summaryCount: number };
/** What `recap:open` answers. */
let opened: { ok: boolean; reason?: string };

function host(): HTMLElement | null {
  return document.getElementById('smart-tab-notes-recap');
}

function card(): HTMLElement | null {
  const element = host()?.shadowRoot?.querySelector<HTMLElement>('.popup');
  return element && !element.hidden ? element : null;
}

function press(attribute: string): void {
  const button = host()!.shadowRoot!.querySelector<HTMLButtonElement>(`[${attribute}]`);
  if (!button) throw new Error(`Missing button [${attribute}]. Popup shows: ${card()?.textContent}`);
  button.click();
}

/** Let the check's message resolve and its timers run. */
async function settle(ms = 2_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function sent(kind: string): unknown[] {
  return bus.send.mock.calls.filter((call) => call[0] === kind).map((call) => call[1]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '<p>A page the reader has been here before.</p>';
  saved = { show: true, noteCount: 3, summaryCount: 0 };
  opened = { ok: true };
  bus.send.mockImplementation(async (kind: string) => {
    if (kind === 'recap:check') return { ok: true, data: saved };
    if (kind === 'recap:open') return { ok: true, data: opened };
    return { ok: true, data: { ok: true } };
  });
});

afterEach(() => {
  popup?.dispose();
  vi.useRealTimers();
});

describe('offering a recap on the page', () => {
  it('asks the worker what is saved here, then offers it', async () => {
    popup = installRecapPopup({ requireUserGesture: false });
    // Nothing is shown before the answer comes back.
    expect(card()).toBeNull();
    await settle();

    expect(sent('recap:check')).toEqual([{ url: location.href }]);
    expect(card()!.textContent).toContain('You have 3 notes here.');
    expect(card()!.textContent).toContain('See what you learned?');
  });

  it('counts one note, and chat summaries alongside notes', async () => {
    saved = { show: true, noteCount: 1, summaryCount: 2 };
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    expect(card()!.textContent).toContain('You have 1 note and 2 chat summaries here.');
  });

  it('stays away when the worker says the offer was already made, or nothing is saved', async () => {
    saved = { show: false, noteCount: 4, summaryCount: 0 };
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    expect(card()).toBeNull();

    popup.dispose();
    saved = { show: true, noteCount: 0, summaryCount: 0 };
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    expect(card()).toBeNull();
  });

  it('opens the recap and gets out of the way', async () => {
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    press('data-recap-open');
    await settle();

    expect(sent('recap:open')).toEqual([{ url: location.href }]);
    expect(card()).toBeNull();
  });

  it('stays, and says why, when the recap could not be opened', async () => {
    opened = { ok: false, reason: 'Nothing is saved on this page.' };
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    press('data-recap-open');
    await settle();

    expect(card()!.textContent).toContain('Nothing is saved on this page.');
    // Still there to try again.
    expect(host()!.shadowRoot!.querySelector('[data-recap-open]')).not.toBeNull();
  });

  it('closes on Dismiss and on Escape, without asking the worker anything', async () => {
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    press('data-recap-dismiss');
    expect(card()).toBeNull();
    expect(sent('recap:open')).toEqual([]);

    popup.dispose();
    bus.send.mockClear();
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    expect(card()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card()).toBeNull();
  });

  it('ignores a page script clicking its buttons', async () => {
    // The default: only a trusted input opens the side panel. jsdom events
    // are never trusted, so this is exactly what a page script can manage.
    popup = installRecapPopup();
    await settle();
    press('data-recap-open');
    await settle();
    expect(sent('recap:open')).toEqual([]);
    expect(card()).not.toBeNull();
  });

  it('offers again when a single-page app moves to another page', async () => {
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    press('data-recap-dismiss');
    expect(card()).toBeNull();

    window.history.pushState({}, '', '/another-page');
    await settle();
    expect(sent('recap:check')).toHaveLength(2);
    expect(card()).not.toBeNull();
  });

  it('leaves nothing behind when disposed, and installs only one popup', async () => {
    popup = installRecapPopup({ requireUserGesture: false });
    await settle();
    const second = installRecapPopup({ requireUserGesture: false });
    await settle();
    expect(document.querySelectorAll('#smart-tab-notes-recap')).toHaveLength(1);
    second.dispose();
    expect(host()).toBeNull();
  });
});
