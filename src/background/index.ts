/**
 * Background service worker.
 *
 * Responsibilities in the scaffold:
 *   - open the side panel when the toolbar icon is clicked
 *   - answer tab queries for the side panel (it has no direct tabs access
 *     pattern we want to spread around; everything goes through here)
 *   - relay selection events from content scripts to the side panel
 *   - toolbar Explain/Ask (explain.ts) and Save (annotations.ts)
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
import { runExplain } from './explain';
import { callerOf, deleteNote, listNotes, saveNote, setAnchorState, updateNote } from './notes';
import { getTabContext } from '../shared/tabContext';
import { getActiveTabRef, listTabGroups, listTabs } from '../shared/tabs';
import { FOCUSED_NOTE_KEY } from '../shared/types';

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
  /** Toolbar Explain and Ask. Reads the sender's tab and others in its window. */
  'explain:run': async (payload, sender) => {
    if (!isFromTab(sender, EXTENSION_ORIGIN) || !sender.tab) return { ok: false, error: 'Not from a tab.' };
    return runExplain(payload, sender.tab);
  },

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

  /* ---------------------------------------------------------------- *
   * Saved notes. The worker owns storage; content scripts ask for it.
   * ---------------------------------------------------------------- */

  // Saved notes (highlights). See notes.ts for who may touch which notes.
  'annotations:save': async (payload, sender) => {
    const caller = callerOf(sender, EXTENSION_ORIGIN);
    return caller ? saveNote(payload, caller) : { ok: false, reason: 'Unknown sender.' };
  },

  'annotations:list': async ({ url }, sender) => {
    const caller = callerOf(sender, EXTENSION_ORIGIN);
    return caller ? listNotes(url, caller) : { annotations: [], reason: 'Unknown sender.' };
  },

  'annotations:update': async (payload, sender) => {
    const caller = callerOf(sender, EXTENSION_ORIGIN);
    return caller ? updateNote(payload, caller) : { ok: false, reason: 'Unknown sender.' };
  },

  'annotations:delete': async ({ id }, sender) => {
    const caller = callerOf(sender, EXTENSION_ORIGIN);
    return caller ? deleteNote(id, caller) : { ok: false, reason: 'Unknown sender.' };
  },

  /**
   * The user clicked a note's highlighted text: show that note in the side
   * panel, opening the panel if it is closed.
   */
  'annotations:focus': async ({ id }, sender) => {
    if (!isFromTab(sender, EXTENSION_ORIGIN) || sender.tab?.id === undefined || typeof id !== 'string') {
      return { ok: false, reason: 'not from a tab' };
    }
    const { id: tabId, windowId } = sender.tab;
    // Before any await: opening the panel is only allowed while the click's
    // user gesture is still live. If the browser says no, the card on the
    // page still shows the note.
    const opened = chrome.sidePanel.open({ windowId }).then(() => true, () => false);
    // A panel that is only now opening misses the message below; it reads this.
    await chrome.storage.session.set({ [FOCUSED_NOTE_KEY]: { id, tabId, windowId, at: Date.now() } }).catch(() => {});
    await opened;
    await notify('sidepanel', 'annotations:focused', { id, tabId, windowId });
    return { ok: true };
  },

  'annotations:anchorState': async ({ id, orphaned }, sender) => {
    const caller = callerOf(sender, EXTENSION_ORIGIN);
    return caller ? setAnchorState(id, orphaned, caller) : { ok: false, reason: 'Unknown sender.' };
  },

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
