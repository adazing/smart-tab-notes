/**
 * Toolbar Explain and Ask, run in the background worker.
 *
 *   content script --explain:run--> worker --getTabContext--> tabs
 *                                          --POST /explain--> backend
 *
 * The worker, not the content script, decides which tabs are read: the
 * sender's own tab plus a few other loaded tabs in the same window (its tab
 * group first when it has one). Content scripts never choose tab ids.
 */

import { ApiError, EXPLAIN_LIMITS, postExplain, type ExplainRequest } from '../shared/api';
import { normalizeUrl } from '../shared/normalize-url';
import { getTabContext } from '../shared/tabContext';
import { isAccessible, isLoaded, isPdfUrl } from '../shared/tabs';
import type { ExplainResult, ExplainRun, ExplainSource, TabContext } from '../shared/types';

/** Other tabs read for one explanation. The backend keeps the best ~2,000 tokens of them. */
export const MAX_OTHER_TABS = 8;
/** Per other tab. The backend trims to 600 tokens, but ranks tabs on their full text. */
export const OTHER_TAB_CHARS = 30_000;

const LOG = '[smart-tab-notes:explain]';

/** Same page, ignoring #hash, tracking params and trailing slashes. */
export function samePage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    return normalizeUrl(a) === normalizeUrl(b);
  } catch {
    return false;
  }
}

/**
 * Which other tabs to read alongside `current`: loaded, readable web pages in
 * its window, tabs in its group first, then most recently used, at most
 * MAX_OTHER_TABS.
 */
export function pickOtherTabs(current: chrome.tabs.Tab, windowTabs: chrome.tabs.Tab[]): number[] {
  const group = current.groupId ?? -1;
  const candidates = windowTabs.filter((tab) => {
    const url = tab.url ?? '';
    return tab.id !== undefined && tab.id !== current.id && isAccessible(url) && !isPdfUrl(url) && isLoaded(tab);
  });
  const rank = (tab: chrome.tabs.Tab): [number, number] => [
    group !== -1 && tab.groupId === group ? 0 : 1,
    -((tab as { lastAccessed?: number }).lastAccessed ?? 0),
  ];
  return candidates
    .sort((a, b) => {
      const [ga, la] = rank(a);
      const [gb, lb] = rank(b);
      return ga - gb || la - lb;
    })
    .slice(0, MAX_OTHER_TABS)
    .map((tab) => tab.id!);
}

/** The /explain body for a selection, its page and the other tabs that could be read. */
export function buildExplainRequest(run: ExplainRun, page: TabContext | undefined, others: TabContext[]): ExplainRequest {
  const request: ExplainRequest = {
    selected_text: run.text.trim().slice(0, EXPLAIN_LIMITS.selectedText),
    page_text: page?.status === 'ok' ? page.text.slice(0, EXPLAIN_LIMITS.pageText) : '',
    other_tabs: others
      .filter((tab) => tab.status === 'ok' && tab.text.trim())
      .slice(0, EXPLAIN_LIMITS.otherTabs)
      .map((tab) => ({
        tab_id: tab.tabId,
        title: tab.title.slice(0, EXPLAIN_LIMITS.tabTitle),
        url: tab.url.slice(0, EXPLAIN_LIMITS.tabUrl),
        text: tab.text.slice(0, OTHER_TAB_CHARS),
      })),
  };
  const question = run.question?.trim();
  if (question) request.question = question.slice(0, EXPLAIN_LIMITS.question);
  return request;
}

/** Map used_tab_ids back to the tabs that were sent, in the order the backend gave. */
export function sourcesFor(usedTabIds: number[], others: TabContext[]): ExplainSource[] {
  return usedTabIds.flatMap((id) => {
    const tab = others.find((candidate) => candidate.tabId === id);
    return tab ? [{ tabId: tab.tabId, title: tab.title, url: tab.url }] : [];
  });
}

/** Explain (or answer a question about) `run.text` on `tab`. Never throws. */
export async function runExplain(run: ExplainRun, tab: chrome.tabs.Tab): Promise<ExplainResult> {
  if (typeof run.text !== 'string' || !run.text.trim()) return { ok: false, error: 'Select some text first.' };
  if (run.question !== undefined && typeof run.question !== 'string') return { ok: false, error: 'Invalid question.' };
  if (tab.id === undefined || !samePage(tab.url, run.url)) {
    return { ok: false, error: 'This page has changed. Select the text again.' };
  }

  try {
    const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
    const [page, ...others] = await getTabContext([tab.id, ...pickOtherTabs(tab, windowTabs)]);
    const response = await postExplain(buildExplainRequest(run, page, others));
    return { ok: true, explanation: response.explanation, sources: sourcesFor(response.used_tab_ids, others) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error: error.message };
    console.error(LOG, 'explain failed:', error);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
