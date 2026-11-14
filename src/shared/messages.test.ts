import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNoReceiverError, onMessage } from './messages';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
const listeners: Array<(m: unknown, s: chrome.runtime.MessageSender, r: (x?: unknown) => void) => boolean> = [];

vi.stubGlobal('chrome', {
  runtime: {
    getURL: (path: string) => ORIGIN + path,
    onMessage: { addListener: (l: (typeof listeners)[number]) => listeners.push(l), removeListener: vi.fn() },
  },
});
afterEach(() => { listeners.length = 0; });

const envelope = (kind: string, target: string) => ({ marker: '@smart-tab-notes/v1', kind, target, payload: {}, sentAt: 0 });

describe('onMessage for the side panel', () => {
  it('ignores messages posted directly by a content script', () => {
    const handler = vi.fn(() => ({ ok: true }));
    onMessage('sidepanel', 'page:selectionChanged', handler);
    const fromPage = { url: 'https://evil.example/', tab: { id: 3 } as chrome.tabs.Tab };
    expect(listeners[0]!(envelope('page:selectionChanged', 'sidepanel'), fromPage, vi.fn())).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts relays from the background worker', () => {
    const handler = vi.fn(() => ({ ok: true }));
    onMessage('sidepanel', 'page:selectionChanged', handler);
    const fromWorker = { url: `${ORIGIN}background.js` };
    expect(listeners[0]!(envelope('page:selectionChanged', 'sidepanel'), fromWorker, vi.fn())).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});

it('treats a content script orphaned by an extension reload as "no receiver"', () => {
  expect(isNoReceiverError('Extension context invalidated.')).toBe(true);
});
