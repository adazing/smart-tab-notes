/**
 * getTabContext: readable text and chunks for a set of tabs.
 *
 *   const [page, ...others] = await getTabContext([activeTabId, 12, 15]);
 *   if (page.status === 'ok') send(page.text, page.chunks);
 *
 * Results come back in the order of `tabIds`, one per id, and this never
 * throws: a tab that cannot be read gets a `status` saying why (see
 * TabContextStatus) and empty text, so callers can show which tabs were
 * skipped.
 *
 * Uses chrome.tabs and chrome.scripting, so it runs in the background worker
 * or the side panel. Content scripts ask the worker with the
 * `tabs:getContext` message.
 *
 * Privacy: this is the only place page text is read for the AI, and only
 * for the tab ids the caller passes in.
 */

import { chunkBlocks, type ChunkOptions } from './chunk';
import { isAccessible, isLoaded, isPdfUrl } from './tabs';
import type { ExtractedPage, TabContext } from './types';

/** Built from src/extract by vite.extract.config.ts. */
export const EXTRACT_SCRIPT = 'extract.js';

export interface TabContextOptions {
  /** Cap on text per tab. Default 200,000 characters. */
  maxChars?: number;
  chunk?: ChunkOptions;
}

type Base = Pick<TabContext, 'tabId' | 'title' | 'url' | 'groupId' | 'loaded'>;

function empty(base: Base, status: TabContext['status'], error?: string): TabContext {
  const context: TabContext = {
    ...base,
    status,
    text: '',
    wordCount: 0,
    chunks: [],
    extractor: null,
    truncated: false,
  };
  if (error) context.error = error;
  return context;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface InjectedResult {
  contentType: string;
  page: ExtractedPage | null;
}

/** Runs in the page, after extract.js has defined the global. */
function runExtractor(maxChars: number): InjectedResult {
  const contentType = document.contentType;
  if (contentType === 'application/pdf') return { contentType, page: null };
  const api = (globalThis as unknown as {
    SmartTabNotesExtract?: { extractPage: (doc: Document, options: { maxChars: number }) => ExtractedPage };
  }).SmartTabNotesExtract;
  if (!api) throw new Error('extract.js did not load');
  return { contentType, page: api.extractPage(document, { maxChars }) };
}

async function getOne(tabId: number, options: TabContextOptions): Promise<TabContext> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return empty({ tabId, title: '', url: '', groupId: -1, loaded: false }, 'error', describe(error));
  }

  const url = tab.url ?? tab.pendingUrl ?? '';
  const base: Base = {
    tabId,
    title: tab.title ?? '',
    url,
    groupId: tab.groupId ?? -1,
    loaded: isLoaded(tab),
  };

  if (!isAccessible(url)) return empty(base, 'restricted');
  if (isPdfUrl(url)) return empty(base, 'pdf');
  if (!base.loaded) return empty(base, 'not_loaded');

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [EXTRACT_SCRIPT] });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: runExtractor,
      args: [options.maxChars ?? 200_000],
    });
    const result = injection?.result as InjectedResult | undefined;
    if (!result) return empty(base, 'error', 'No result from the page');
    if (!result.page) return empty(base, 'pdf');

    const { page } = result;
    return {
      ...base,
      title: base.title || page.title,
      status: 'ok',
      text: page.text,
      wordCount: page.wordCount,
      chunks: chunkBlocks(page.blocks, tabId, options.chunk),
      extractor: page.extractor,
      truncated: page.truncated,
    };
  } catch (error) {
    // e.g. file:// without "Allow access to file URLs", an error page, or a
    // tab that navigated away mid-injection.
    return empty(base, 'error', describe(error));
  }
}

export async function getTabContext(
  tabIds: number[],
  options: TabContextOptions = {},
): Promise<TabContext[]> {
  return Promise.all(tabIds.map((tabId) => getOne(tabId, options)));
}
