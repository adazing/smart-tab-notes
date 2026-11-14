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

import {
  notify,
  registerHandlers,
  type MessageHandler,
  type MessageKind,
} from '../shared/messages';
import { isFromExtensionPage, isFromTab } from '../shared/senders';
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
 * Sender checks
 * ------------------------------------------------------------------ */

const EXTENSION_ORIGIN = chrome.runtime.getURL('');

/**
 * Only answer `kind` for extension pages (the side panel). Content scripts run
 * inside web pages, so they must not be able to read other tabs or move focus.
 * A rejected sender gets no response (its send resolves to ok: false).
 */
function extensionPagesOnly<K extends MessageKind>(kind: K, handler: MessageHandler<K>): MessageHandler<K> {
  return (payload, sender) => {
    if (!isFromExtensionPage(sender, EXTENSION_ORIGIN)) {
      throw new Error(`"${kind}" is only answered for extension pages, not ${sender.url ?? 'unknown sender'}`);
    }
    return handler(payload, sender);
  };
}

/* ------------------------------------------------------------------ *
 * Message handlers
 * ------------------------------------------------------------------ */

registerHandlers('background', {
  // No logging or persistence of selected text, questions, or notes in Week 1.
  'toolbar:action': async (_payload, sender) =>
    isFromTab(sender, EXTENSION_ORIGIN) ? { ok: true } : { ok: false, reason: 'not from a tab' },

  'ping': async () => ({ ok: true, endpoint: 'background', at: Date.now() }),

  'tabs:list': extensionPagesOnly('tabs:list', async ({ currentWindowOnly }) => {
    const tabs = await listTabs({ currentWindowOnly });
    return { tabs, groups: await listTabGroups(tabs) };
  }),

  /** Readable text and ~500-token chunks for the given tabs, in order. */
  'tabs:getContext': extensionPagesOnly('tabs:getContext', async ({ tabIds }) => ({
    contexts: await getTabContext(tabIds),
  })),

  'tabs:getActive': extensionPagesOnly('tabs:getActive', async ({ windowId }) => ({
    tab: await getActiveTabRef(windowId),
  })),

  'tabs:focus': extensionPagesOnly('tabs:focus', async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }),

  /**
   * Content scripts report selections here rather than straight to the side
   * panel, so the worker can stamp the tab and window ids (side panels in
   * every window receive the relay and filter on them) and later decide what
   * to do when the panel is closed.
   */
  'page:selectionChanged': async ({ selection }, sender) => {
    // Only content scripts in a tab report selections; drop anything else.
    if (!isFromTab(sender, EXTENSION_ORIGIN) || sender.tab?.id === undefined) {
      return { ok: false, reason: 'not from a tab' };
    }
    await notify('sidepanel', 'page:selectionChanged', {
      selection,
      tabId: sender.tab.id,
      windowId: sender.tab.windowId,
    });
    return { ok: true };
  },
});

/* ------------------------------------------------------------------ *
 * Tab events -> side panel
 * ------------------------------------------------------------------ */

/**
 * Tell side panels that `windowId`'s active tab changed. Every open panel (one
 * per window) receives it; each ignores other windows' events.
 */
async function announceActiveTab(windowId: number): Promise<void> {
  const tab = await getActiveTabRef(windowId);
  await notify('sidepanel', 'tabs:changed', { activeTabId: tab?.tabId ?? null, windowId });
}

chrome.tabs.onActivated.addListener(({ windowId }) => void announceActiveTab(windowId));

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Only once the page has settled, and only for the tab in view.
  if (changeInfo.status === 'complete' && tab.active) void announceActiveTab(tab.windowId);
});

console.log(LOG, 'service worker started');
