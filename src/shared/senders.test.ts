import { describe, expect, it } from 'vitest';
import { isFromExtensionPage, isFromTab } from './senders';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
const sidePanel = { url: `${ORIGIN}sidepanel.html` };
const contentScript = { url: 'https://example.com/article', tab: { id: 5 } as chrome.tabs.Tab };
const panelOpenedAsTab = { url: `${ORIGIN}sidepanel.html`, tab: { id: 9 } as chrome.tabs.Tab };

describe('isFromExtensionPage', () => {
  it('accepts the side panel, even if opened as a tab', () => {
    expect(isFromExtensionPage(sidePanel, ORIGIN)).toBe(true);
    expect(isFromExtensionPage(panelOpenedAsTab, ORIGIN)).toBe(true);
  });

  it('rejects content scripts and senders with no url', () => {
    expect(isFromExtensionPage(contentScript, ORIGIN)).toBe(false);
    expect(isFromExtensionPage({}, ORIGIN)).toBe(false);
  });

  it("rejects a web page whose url merely contains the extension's url", () => {
    expect(isFromExtensionPage({ url: `https://evil.example/?${ORIGIN}`, tab: { id: 1 } as chrome.tabs.Tab }, ORIGIN)).toBe(false);
  });
});

describe('isFromTab', () => {
  it('accepts content scripts in a tab', () => {
    expect(isFromTab(contentScript, ORIGIN)).toBe(true);
  });

  it('rejects the side panel and extension pages opened as tabs', () => {
    expect(isFromTab(sidePanel, ORIGIN)).toBe(false);
    expect(isFromTab(panelOpenedAsTab, ORIGIN)).toBe(false);
  });
});
