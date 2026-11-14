import { subscribePrivacy } from '../shared/privacy';
/**
 * Keeps the side panel in step with whatever tab the user is looking at.
 *
 * This is the one place the panel talks to the background worker about
 * tabs. Views should read from this hook rather than calling `chrome.tabs`
 * themselves, so there is a single path to keep correct.
 *
 * Each window has its own side panel, and every panel receives every tab and
 * selection event. This hook works out which window it is in and ignores
 * events for other windows and selections from other tabs (see pageEvents.ts).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { onMessage, sendToBackground } from '../shared/messages';
import type { SelectionInfo, TabRef } from '../shared/types';
import { isSelectionForPanel, isTabChangeForPanel } from './pageEvents';

export interface PageState {
  /** The tab in view, or null while loading or on a tab we cannot read. */
  activeTab: TabRef | null;
  /** The user's latest selection on that tab. */
  selection: SelectionInfo | null;
  loading: boolean;
  /** Re-fetch the active tab, e.g. after a retry button. */
  refresh: () => void;
}

/** The window this side panel page lives in, or null if it cannot be found. */
async function currentWindowId(): Promise<number | null> {
  try {
    const win = await chrome.windows.getCurrent();
    return win.id ?? null;
  } catch {
    return null;
  }
}

export function usePageState(): PageState {
  const [activeTab, setActiveTab] = useState<TabRef | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // Read by the message listeners, which are registered once.
  const windowIdRef = useRef<number | null>(null);
  const activeTabIdRef = useRef<number | null>(null);
  // Rapid tab switches can return out of order; only the latest request wins.
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    setSelection(null);
    const request = ++requestRef.current;
    setLoading(true);
    const windowId = windowIdRef.current;
    void sendToBackground('tabs:getActive', windowId === null ? {} : { windowId }).then((result) => {
      if (request !== requestRef.current) return;
      const tab = result.ok ? result.data.tab : null;
      if (tab?.tabId !== activeTabIdRef.current) setSelection(null);
      activeTabIdRef.current = tab?.tabId ?? null;
      setActiveTab(tab);
      setLoading(false);
    });
  }, []);

  useEffect(() => subscribePrivacy(() => { setSelection(null); refresh(); }), [refresh]);

  // Initial load: find our window first, then tell the worker we are open.
  useEffect(() => {
    let cancelled = false;
    void currentWindowId().then((windowId) => {
      if (cancelled) return;
      windowIdRef.current = windowId;
      void sendToBackground('sidepanel:ready', {});
      refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // The worker tells every panel when a window's active tab changes.
  useEffect(() => {
    return onMessage('sidepanel', 'tabs:changed', (event) => {
      if (!isTabChangeForPanel(event, { windowId: windowIdRef.current, activeTabId: activeTabIdRef.current })) {
        return { ok: true };
      }
      // A new tab, or a new page loaded in the same tab: the old selection is stale.
      setSelection(null);
      refresh();
      return { ok: true };
    });
  }, [refresh]);

  // Selections are relayed from content scripts via the worker, from every tab.
  useEffect(() => {
    return onMessage('sidepanel', 'page:selectionChanged', (event) => {
      if (isSelectionForPanel(event, { windowId: windowIdRef.current, activeTabId: activeTabIdRef.current })) {
        setSelection(event.selection);
      }
      return { ok: true };
    });
  }, []);

  return { activeTab, selection, loading, refresh };
}
