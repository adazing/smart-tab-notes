/**
 * Reading Chrome's tabs and tab groups.
 *
 * Uses chrome.tabs / chrome.tabGroups, so call these from the background
 * worker or the side panel, not from a content script (which has no access;
 * content scripts go through the `tabs:list` message instead).
 */

import type { TabGroupRef, TabRef } from './types';

const LOG = '[smart-tab-notes:tabs]';

/** Pages we are not allowed to inject into, so there is no content script. */
export function isAccessible(url: string | undefined): boolean {
  if (!url) return false;
  if (!/^(https?|file):/.test(url)) return false;
  // Chrome blocks extensions on its own web properties.
  if (url.startsWith('https://chrome.google.com/webstore')) return false;
  if (url.startsWith('https://chromewebstore.google.com')) return false;
  return true;
}

/**
 * True for URLs that are obviously PDFs. PDFs served without a .pdf
 * extension (e.g. arxiv.org/pdf/...) are caught at extraction time instead,
 * from document.contentType.
 */
export function isPdfUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/** False for tabs Chrome has discarded or not loaded since a restart. */
export function isLoaded(tab: chrome.tabs.Tab): boolean {
  return !tab.discarded && tab.status !== 'unloaded';
}

export function toTabRef(tab: chrome.tabs.Tab): TabRef | null {
  if (tab.id === undefined || tab.windowId === undefined) return null;
  const url = tab.url ?? tab.pendingUrl ?? '';
  const ref: TabRef = {
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId ?? -1,
    title: tab.title ?? '',
    url,
    active: tab.active ?? false,
    index: tab.index ?? 0,
    accessible: isAccessible(url),
    loaded: isLoaded(tab),
  };
  if (tab.favIconUrl) ref.favIconUrl = tab.favIconUrl;
  return ref;
}

/** Open tabs, in tab-strip order. Defaults to every window. */
export async function listTabs(options: { currentWindowOnly?: boolean } = {}): Promise<TabRef[]> {
  const query: chrome.tabs.QueryInfo = options.currentWindowOnly ? { currentWindow: true } : {};
  const found = await chrome.tabs.query(query);
  return found.map(toTabRef).filter((tab): tab is TabRef => tab !== null);
}

/**
 * Tab groups, each with the ids of its tabs from `tabs`. Only groups in the
 * windows `tabs` came from are returned.
 */
export async function listTabGroups(tabs: TabRef[]): Promise<TabGroupRef[]> {
  // tabGroups is unavailable in some channels; never let it break the list.
  if (typeof chrome.tabGroups === 'undefined') return [];
  try {
    const windowIds = new Set(tabs.map((tab) => tab.windowId));
    const groups = await chrome.tabGroups.query({});
    return groups
      .filter((group) => windowIds.has(group.windowId))
      .map((group) => ({
        groupId: group.id,
        windowId: group.windowId,
        title: group.title ?? '',
        color: group.color,
        collapsed: group.collapsed,
        tabIds: tabs.filter((tab) => tab.groupId === group.id).map((tab) => tab.tabId),
      }));
  } catch (error) {
    console.warn(LOG, 'tabGroups.query failed:', error);
    return [];
  }
}

export async function getActiveTabRef(): Promise<TabRef | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? toTabRef(tab) : null;
}
