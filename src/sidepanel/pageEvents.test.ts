import { describe, expect, it } from 'vitest';
import { isSelectionForPanel, isTabChangeForPanel } from './pageEvents';

const panel = { windowId: 1, activeTabId: 10 };

describe('isTabChangeForPanel', () => {
  it("acts on its own window's tab changes and ignores other windows", () => {
    expect(isTabChangeForPanel({ windowId: 1 }, panel)).toBe(true);
    expect(isTabChangeForPanel({ windowId: 2 }, panel)).toBe(false);
  });

  it('refreshes on any change while it does not know its window yet', () => {
    expect(isTabChangeForPanel({ windowId: 2 }, { windowId: null, activeTabId: null })).toBe(true);
  });
});

describe('isSelectionForPanel', () => {
  it('accepts selections from the tab it is showing', () => {
    expect(isSelectionForPanel({ tabId: 10, windowId: 1 }, panel)).toBe(true);
  });

  it('ignores selections from other tabs, including background tabs in the same window', () => {
    expect(isSelectionForPanel({ tabId: 11, windowId: 1 }, panel)).toBe(false);
  });

  it("ignores another window's tab even if this panel does not know its window yet", () => {
    expect(isSelectionForPanel({ tabId: 20, windowId: 2 }, { windowId: null, activeTabId: 10 })).toBe(false);
  });

  it('ignores a matching tab id reported from another window', () => {
    expect(isSelectionForPanel({ tabId: 10, windowId: 2 }, panel)).toBe(false);
  });

  it('ignores selections with no tab, or before the panel has loaded its tab', () => {
    expect(isSelectionForPanel({ windowId: 1 }, panel)).toBe(false);
    expect(isSelectionForPanel({ tabId: 10, windowId: 1 }, { windowId: 1, activeTabId: null })).toBe(false);
  });
});
