import { canReadUrl, getPrivacySettings, normalizeDomain, PRIVACY_KEY, subscribePrivacy } from '../shared/privacy';
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

import { notify, registerHandlers, sendToTab, type MessageHandler, type MessageKind } from '../shared/messages';
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
  void updatePrivacy(async () => { await chrome.storage.local.set({ [PRIVACY_KEY]: await getPrivacySettings() }); }).catch(() => {});
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

let privacyWrites: Promise<unknown> = Promise.resolve();
function updatePrivacy<T>(operation: () => Promise<T>): Promise<T> {
  const next = privacyWrites.then(operation);
  privacyWrites = next.catch(() => {});
  return next;
}
registerHandlers('background', {
  'data:cleared': async (payload, sender) => {
    if (sender.url !== chrome.runtime.getURL('sidepanel.html')) return { ok: false };
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter(tab => tab.id !== undefined).map(tab =>
      sendToTab(tab.id!, 'data:cleared', payload)
    ));
    await notify('sidepanel', 'data:cleared', payload);
    return { ok: true };
  },
  'privacy:update': (request, sender) => updatePrivacy(async () => {
    if (sender.url !== chrome.runtime.getURL('sidepanel.html')) throw new Error('Settings must be changed from the side panel.');
    const settings = await getPrivacySettings();
    if (request.action === 'complete') settings.onboardingComplete = true;
    else {
      const domain = normalizeDomain(request.domain ?? '');
      if (request.action === 'add') {
        if (settings.blockedDomains.includes(domain)) throw new Error('That domain is already blocked.');
        settings.blockedDomains.push(domain);
      } else settings.blockedDomains = settings.blockedDomains.filter(value => value !== domain);
    }
    await chrome.storage.local.set({ [PRIVACY_KEY]: settings });
    return settings;
  }),
  // No logging or persistence of selected text, questions, or notes in Week 1.
  'toolbar:action': async (payload, sender) => ({
    ok: isFromTab(sender, EXTENSION_ORIGIN) && await canReadUrl(sender.tab?.url ?? '') && await canReadUrl(payload.url),
  }),

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

  /** The side panel says it has opened. It fetches its own tab, so there is nothing to seed yet. */
  'sidepanel:ready': extensionPagesOnly('sidepanel:ready', async () => ({ ok: true })),

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
    if (!isFromTab(sender, EXTENSION_ORIGIN) || sender.tab?.id === undefined) {
      return { ok: false, reason: 'not from a tab' };
    }
    if (selection && (!await canReadUrl(sender.tab.url ?? '') || !await canReadUrl(selection.url))) return { ok: false };
    await notify('sidepanel', 'page:selectionChanged', {
      selection, tabId: sender.tab.id, windowId: sender.tab.windowId,
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

subscribePrivacy(() => {
  void chrome.tabs.query({ active: true }).then(tabs =>
    Promise.all([...new Set(tabs.map(tab => tab.windowId))].map(announceActiveTab))
  ).catch(() => {});
});

console.log(LOG, 'service worker started');
