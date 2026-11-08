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
import { getTabContext } from '../shared/tabContext';
import { getActiveTabRef, listTabGroups, listTabs } from '../shared/tabs';

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
 * Message handlers
 * ------------------------------------------------------------------ */

registerHandlers('background', {
  'ping': async () => ({ ok: true, endpoint: 'background', at: Date.now() }),

  'tabs:list': async ({ currentWindowOnly }) => {
    const tabs = await listTabs({ currentWindowOnly });
    return { tabs, groups: await listTabGroups(tabs) };
  },

  /** Readable text and ~500-token chunks for the given tabs, in order. */
  'tabs:getContext': async ({ tabIds }) => ({ contexts: await getTabContext(tabIds) }),

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
