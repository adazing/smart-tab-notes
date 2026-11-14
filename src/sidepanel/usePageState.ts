/**
 * Keeps the side panel in step with whatever tab the user is looking at.
 *
 * This is the one place the panel talks to the background worker about
 * tabs. Views should read from this hook rather than calling `chrome.tabs`
 * themselves, so there is a single path to keep correct.
 */

import { useCallback, useEffect, useState } from 'react';
import { onMessage, sendToBackground } from '../shared/messages';
import type { SelectionInfo, TabRef } from '../shared/types';

export interface PageState {
  /** The tab in view, or null while loading or on a tab we cannot read. */
  activeTab: TabRef | null;
  /** The user's latest selection on that tab. */
  selection: SelectionInfo | null;
  loading: boolean;
  /** Re-fetch the active tab, e.g. after a retry button. */
  refresh: () => void;
}

export function usePageState(): PageState {
  const [activeTab, setActiveTab] = useState<TabRef | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    void sendToBackground('tabs:getActive', {}).then((result) => {
      setActiveTab(result.ok ? result.data.tab : null);
      setLoading(false);
    });
  }, []);

  // Initial load, and tell the worker we are open.
  useEffect(() => {
    void sendToBackground('sidepanel:ready', {});
    refresh();
  }, [refresh]);

  // The worker tells us when the user switches tabs.
  useEffect(() => {
    return onMessage('sidepanel', 'tabs:changed', () => {
      setSelection(null);
      refresh();
      return { ok: true };
    });
  }, [refresh]);

  // Selections are relayed from the content script via the worker.
  useEffect(() => {
    return onMessage('sidepanel', 'page:selectionChanged', ({ selection: next }) => {
      setSelection(next);
      return { ok: true };
    });
  }, []);

  return { activeTab, selection, loading, refresh };
}
