import { describe, expect, it } from 'vitest';
import { isFromExtensionPage, isFromTab, mayReachUrl } from './senders';

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

describe('mayReachUrl', () => {
  const tab = (url: string) => ({ url, tab: { id: 5 } as chrome.tabs.Tab });

  it('lets a content script reach the page it runs on', () => {
    expect(mayReachUrl(contentScript, 'https://example.com/article', ORIGIN)).toBe(true);
  });

  it('ignores the differences normalization ignores', () => {
    expect(mayReachUrl(tab('https://example.com/article/'), 'https://example.com/article?utm_source=x', ORIGIN)).toBe(true);
  });

  it('refuses another page, including a near miss on the same host', () => {
    expect(mayReachUrl(contentScript, 'https://bank.example/account', ORIGIN)).toBe(false);
    expect(mayReachUrl(contentScript, 'https://example.com/other', ORIGIN)).toBe(false);
    expect(mayReachUrl(tab('https://evil.example/'), 'https://example.com/article', ORIGIN)).toBe(false);
  });

  it('refuses a sender with no url, and a url storage would not take', () => {
    expect(mayReachUrl({ tab: { id: 5 } as chrome.tabs.Tab }, 'https://example.com/article', ORIGIN)).toBe(false);
    expect(mayReachUrl(contentScript, 'javascript:void 0', ORIGIN)).toBe(false);
    expect(mayReachUrl(contentScript, 'not a url', ORIGIN)).toBe(false);
  });

  it('trusts the side panel with any page, since it shows whichever tab is active', () => {
    expect(mayReachUrl(sidePanel, 'https://example.com/other', ORIGIN)).toBe(true);
    expect(mayReachUrl(panelOpenedAsTab, 'https://example.com/other', ORIGIN)).toBe(true);
  });
});
