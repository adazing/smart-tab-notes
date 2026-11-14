import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTabContext, runExtractor } from './tabContext';
import type { ExtractedPage } from './types';

type FakeTab = Partial<chrome.tabs.Tab> & { id: number };

const article: ExtractedPage = {
  title: 'From the page',
  url: 'https://example.com/a',
  text: 'Intro\n\nSome words here.',
  wordCount: 4,
  blocks: [
    { kind: 'heading', text: 'Intro', level: 1 },
    { kind: 'text', text: 'Some words here.' },
  ],
  extractor: 'readability',
  truncated: false,
};

let tabs: Record<number, FakeTab>;
let pageResults: Record<number, { contentType: string; page: ExtractedPage | null } | Error>;
const executeScript = vi.fn();

beforeEach(() => {
  tabs = {};
  pageResults = {};
  executeScript.mockReset();
  executeScript.mockImplementation(async (injection: { target: { tabId: number }; files?: string[] }) => {
    const result = pageResults[injection.target.tabId];
    if (result instanceof Error) throw result;
    return injection.files ? [{ result: undefined }] : [{ result }];
  });
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs[id];
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      }),
    },
    scripting: { executeScript },
  });
});

const tab = (id: number, url: string, extra: Partial<chrome.tabs.Tab> = {}): FakeTab => ({
  id,
  url,
  title: `Tab ${id}`,
  groupId: -1,
  status: 'complete',
  discarded: false,
  ...extra,
});

describe('getTabContext', () => {
  it('extracts and chunks a normal page', async () => {
    tabs[1] = tab(1, 'https://example.com/a', { groupId: 5 });
    pageResults[1] = { contentType: 'text/html', page: article };

    const [context] = await getTabContext([1]);

    expect(context).toMatchObject({
      tabId: 1,
      title: 'Tab 1',
      url: 'https://example.com/a',
      groupId: 5,
      loaded: true,
      status: 'ok',
      wordCount: 4,
      extractor: 'readability',
    });
    expect(context!.chunks).toEqual([
      expect.objectContaining({ id: 't1-c0', heading: 'Intro', text: 'Intro\n\nSome words here.' }),
    ]);
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['extract.js'] });
  });

  it('skips chrome://, the Web Store, PDFs and unloaded tabs without injecting', async () => {
    tabs[1] = tab(1, 'chrome://settings');
    tabs[2] = tab(2, 'https://chromewebstore.google.com/detail/abc');
    tabs[3] = tab(3, 'https://example.com/paper.PDF?download=1');
    tabs[4] = tab(4, 'https://example.com/old', { discarded: true });
    tabs[5] = tab(5, 'https://example.com/restored', { status: 'unloaded' });

    const contexts = await getTabContext([1, 2, 3, 4, 5]);

    expect(contexts.map((c) => c.status)).toEqual(['restricted', 'restricted', 'pdf', 'not_loaded', 'not_loaded']);
    expect(contexts[3]).toMatchObject({ title: 'Tab 4', url: 'https://example.com/old', loaded: false, text: '', chunks: [] });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('detects PDFs served without a .pdf extension', async () => {
    tabs[1] = tab(1, 'https://arxiv.org/pdf/2301.00001');
    pageResults[1] = { contentType: 'application/pdf', page: null };
    expect((await getTabContext([1]))[0]!.status).toBe('pdf');
  });

  it('reports closed tabs and injection failures as errors instead of throwing', async () => {
    tabs[2] = tab(2, 'https://example.com/broken');
    pageResults[2] = new Error('Frame with ID 0 is showing error page');

    const [closed, blocked] = await getTabContext([99, 2]);

    expect(closed).toMatchObject({ tabId: 99, status: 'error', error: 'No tab with id: 99.' });
    expect(blocked).toMatchObject({ tabId: 2, status: 'error', loaded: true });
    expect(blocked!.error).toContain('error page');
  });

  it('labels the result with the page actually read if the tab navigated meanwhile', async () => {
    tabs[1] = tab(1, 'https://example.com/a');
    pageResults[1] = { contentType: 'text/html', page: { ...article, url: 'https://other.example/b', title: 'Page B' } };
    expect((await getTabContext([1]))[0]).toMatchObject({ status: 'ok', url: 'https://other.example/b', title: 'Page B' });

    tabs[2] = tab(2, 'https://example.com/a');
    pageResults[2] = { contentType: 'text/html', page: { ...article, url: 'chrome://settings/' } };
    expect((await getTabContext([2]))[0]).toMatchObject({ status: 'restricted', url: 'chrome://settings/', text: '' });
  });

  it('reports local files as restricted: the extension has no file:// permission', async () => {
    tabs[1] = tab(1, 'file:///Users/me/notes.html');
    expect((await getTabContext([1]))[0]!.status).toBe('restricted');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('returns results in the order the ids were given', async () => {
    tabs[1] = tab(1, 'chrome://newtab');
    tabs[2] = tab(2, 'https://example.com/a');
    pageResults[2] = { contentType: 'text/html', page: article };
    const contexts = await getTabContext([2, 1]);
    expect(contexts.map((c) => c.tabId)).toEqual([2, 1]);
  });
});

describe('runExtractor (the function injected into the page)', () => {
  it('returns no page for a PDF, without needing extract.js', () => {
    vi.stubGlobal('document', { contentType: 'application/pdf' });
    expect(runExtractor(1000)).toEqual({ contentType: 'application/pdf', page: null });
  });

  it('throws when extract.js did not load', () => {
    vi.stubGlobal('document', { contentType: 'text/html' });
    expect(() => runExtractor(1000)).toThrow('extract.js did not load');
  });

  it('calls the injected extractor with the size cap', () => {
    const doc = { contentType: 'text/html' };
    const extractPage = vi.fn(() => article);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('SmartTabNotesExtract', { extractPage });
    expect(runExtractor(1234)).toEqual({ contentType: 'text/html', page: article });
    expect(extractPage).toHaveBeenCalledWith(doc, { maxChars: 1234 });
  });
});
