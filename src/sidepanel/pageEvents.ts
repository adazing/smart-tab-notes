/**
 * Which tab and selection events a side panel should act on.
 *
 * Every open side panel (one per window) receives every `tabs:changed` and
 * `page:selectionChanged` relay, because they go out over
 * chrome.runtime.sendMessage. Each panel keeps only the events for its own
 * window, and only selections from the tab it is showing.
 *
 * Pure functions so they can be unit tested without Chrome.
 */

export interface PanelScope {
  /** The window this panel lives in, or null until known (or if unknown). */
  windowId: number | null;
  /** The tab the panel is showing, or null while loading. */
  activeTabId: number | null;
}

/** True when a `tabs:changed` event is about this panel's window. */
export function isTabChangeForPanel(event: { windowId: number }, panel: PanelScope): boolean {
  // Before the panel knows its window it cannot tell, so it refreshes anyway.
  return panel.windowId === null || event.windowId === panel.windowId;
}

/** True when a selection event comes from the tab this panel is showing. */
export function isSelectionForPanel(
  event: { tabId?: number; windowId?: number },
  panel: PanelScope,
): boolean {
  if (event.tabId === undefined || panel.activeTabId === null) return false;
  if (event.tabId !== panel.activeTabId) return false;
  return panel.windowId === null || event.windowId === undefined || event.windowId === panel.windowId;
}
