/**
 * Background service worker.
 *
 * Responsibilities in the scaffold:
 *   - open the side panel when the toolbar icon is clicked
 *   - answer tab queries for the side panel (it has no direct tabs access
 *     pattern we want to spread around; everything goes through here)
 *   - relay selection events from content scripts to the side panel
 *
 * Remember this worker is torn down when idle. Keep state in
 * chrome.storage, not in module variables.
 */

import { registerHandlers, notify } from '../shared/messages';
import type { TabGroupRef, TabRef } from '../shared/types';

const LOG = '[smart-tab-notes:bg]';

/* ------------------------------------------------------------------ *
 * Side panel wiring
 * ------------------------------------------------------------------ */

/**
 * Make a click on the toolbar icon toggle the side panel.
 *
 * This has to run on every worker start, not just on install: the setting
 * lives with the worker's registration and a fresh profile that installs
 * from the store would otherwise never get it.
 */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error(LOG, 'setPanelBehavior failed:', error));

chrome.runtime.onInstalled.addListener((details) => {
  console.log(LOG, 'installed:', details.reason);
});

/* ------------------------------------------------------------------ *
 * Tab helpers
 * ------------------------------------------------------------------ */

/** Pages we are not allowed to inject into, so there is no content script. */
function isAccessible(url: string | undefined): boolean {
  if (!url) return false;
  if (!/^(https?|file):/.test(url)) return false;
  // Chrome blocks extensions on its own web properties.
  if (url.startsWith('https://chrome.google.com/webstore')) return false;
  if (url.startsWith('https://chromewebstore.google.com')) return false;
  return true;
}

function toTabRef(tab: chrome.tabs.Tab): TabRef | null {
  if (tab.id === undefined || tab.windowId === undefined) return null;
  const ref: TabRef = {
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId ?? -1,
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
    active: tab.active ?? false,
    index: tab.index ?? 0,
    accessible: isAccessible(tab.url ?? tab.pendingUrl),
  };
  if (tab.favIconUrl) ref.favIconUrl = tab.favIconUrl;
  return ref;
}

async function listGroups(tabs: TabRef[]): Promise<TabGroupRef[]> {
  // tabGroups is unavailable in some channels; never let it break the list.
  if (typeof chrome.tabGroups === 'undefined') return [];
  try {
    const groups = await chrome.tabGroups.query({});
    return groups.map((group) => ({
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

async function getActiveTabRef(): Promise<TabRef | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? toTabRef(tab) : null;
}

/* ------------------------------------------------------------------ *
 * Message handlers
 * ------------------------------------------------------------------ */

registerHandlers('background', {
  'ping': async () => ({ ok: true, endpoint: 'background', at: Date.now() }),

  'tabs:list': async ({ currentWindowOnly }) => {
    const query: chrome.tabs.QueryInfo = currentWindowOnly ? { currentWindow: true } : {};
    const found = await chrome.tabs.query(query);
    const tabs = found
      .map(toTabRef)
      .filter((tab): tab is TabRef => tab !== null);
    return { tabs, groups: await listGroups(tabs) };
  },

  'tabs:getActive': async () => ({ tab: await getActiveTabRef() }),

  'tabs:focus': async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  },

  /**
   * Content scripts report selections here rather than straight to the side
   * panel, so the worker can stamp the tab id and later decide what to do
   * when the panel is closed.
   */
  'page:selectionChanged': async ({ selection }, sender) => {
    const payload: { selection: typeof selection; tabId?: number } = { selection };
    if (sender.tab?.id !== undefined) payload.tabId = sender.tab.id;
    await notify('sidepanel', 'page:selectionChanged', payload);
    return { ok: true };
  },
});

/* ------------------------------------------------------------------ *
 * Tab events -> side panel
 * ------------------------------------------------------------------ */

async function announceActiveTab(): Promise<void> {
  const tab = await getActiveTabRef();
  await notify('sidepanel', 'tabs:changed', { activeTabId: tab?.tabId ?? null });
}

chrome.tabs.onActivated.addListener(() => void announceActiveTab());

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Only once the page has settled, and only for the tab in view.
  if (changeInfo.status === 'complete' && tab.active) void announceActiveTab();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void announceActiveTab();
});

console.log(LOG, 'service worker started');
