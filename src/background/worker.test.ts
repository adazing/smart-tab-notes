import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabContext } from '../shared/types';
import { buildExplainRequest, MAX_OTHER_TABS, OTHER_TAB_CHARS, pickOtherTabs, runExplain, samePage } from './explain';
import { callerOf, deleteNote, listNotes, saveNote, setAnchorState, updateNote, type Caller } from './notes';
import { db } from '../shared/database';
import { getPageByUrl, listAnnotations } from '../shared/storage';
import { getTabContext } from '../shared/tabContext';

vi.mock('../shared/tabContext', () => ({ getTabContext: vi.fn() }));

const ORIGIN = 'chrome-extension://abc/';

const tab = (id: number, url: string, extra: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab =>
  ({ id, url, title: `Tab ${id}`, windowId: 1, groupId: -1, status: 'complete', discarded: false, ...extra }) as chrome.tabs.Tab;

const context = (tabId: number, text: string, status: TabContext['status'] = 'ok'): TabContext => ({
  tabId, title: `Tab ${tabId}`, url: `https://site${tabId}.example/`, groupId: -1, loaded: true, status,
  text, wordCount: text.split(/\s+/).length, chunks: [], extractor: 'readability', truncated: false,
});

describe('choosing other tabs', () => {
  it('keeps loaded web pages in the window, its group first, then most recent', () => {
    const current = tab(1, 'https://a.example/', { groupId: 5 });
    const others = [
      current,
      tab(2, 'https://b.example/', { lastAccessed: 10 } as Partial<chrome.tabs.Tab>),
      tab(3, 'https://c.example/', { lastAccessed: 30 } as Partial<chrome.tabs.Tab>),
      tab(4, 'https://d.example/', { groupId: 5, lastAccessed: 1 } as Partial<chrome.tabs.Tab>),
      tab(5, 'chrome://settings'),
      tab(6, 'https://e.example/paper.pdf'),
      tab(7, 'https://f.example/', { discarded: true }),
    ];
    expect(pickOtherTabs(current, others)).toEqual([4, 3, 2]);
  });

  it('reads at most MAX_OTHER_TABS', () => {
    const current = tab(0, 'https://a.example/');
    const many = Array.from({ length: 20 }, (_, i) => tab(i + 1, `https://s${i}.example/`));
    expect(pickOtherTabs(current, many)).toHaveLength(MAX_OTHER_TABS);
  });

  it('treats URLs differing only by hash or tracking params as the same page', () => {
    expect(samePage('https://a.example/x?utm_source=y#top', 'https://a.example/x')).toBe(true);
    expect(samePage('https://a.example/x', 'https://a.example/y')).toBe(false);
    expect(samePage(undefined, 'https://a.example/')).toBe(false);
  });
});

describe('building the /explain request', () => {
  it('sends the page text, readable other tabs trimmed, and a trimmed question', () => {
    const request = buildExplainRequest(
      { text: '  word  ', url: 'https://a.example/', question: '  why?  ' },
      context(1, 'page text'),
      [context(2, 'x'.repeat(OTHER_TAB_CHARS + 10)), context(3, '', 'not_loaded'), context(4, '   ')],
    );
    expect(request).toEqual({
      selected_text: 'word',
      page_text: 'page text',
      other_tabs: [{ tab_id: 2, title: 'Tab 2', url: 'https://site2.example/', text: 'x'.repeat(OTHER_TAB_CHARS) }],
      question: 'why?',
    });
  });

  it('explains without page text when the page could not be read, and drops a blank question', () => {
    const request = buildExplainRequest({ text: 'w', url: 'u', question: ' ' }, context(1, '', 'error'), []);
    expect(request).toEqual({ selected_text: 'w', page_text: '', other_tabs: [] });
  });
});

describe('runExplain', () => {
  const current = tab(1, 'https://site1.example/');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn(async () => [current, tab(2, 'https://site2.example/')]) },
      storage: { local: { get: vi.fn(async () => ({})) } },
    });
    vi.mocked(getTabContext).mockResolvedValue([context(1, 'page'), context(2, 'other')]);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('calls /explain and maps used tab ids to sources', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ explanation: 'It means.', used_tab_ids: [2, 99] })));
    vi.stubGlobal('fetch', fetch);
    const result = await runExplain({ text: 'word', url: 'https://site1.example/#x' }, current);
    expect(result).toEqual({ ok: true, explanation: 'It means.', sources: [{ tabId: 2, title: 'Tab 2', url: 'https://site2.example/' }] });
    expect(getTabContext).toHaveBeenCalledWith([1, 2]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/explain');
    expect(JSON.parse(init.body as string)).toMatchObject({ selected_text: 'word', page_text: 'page' });
  });

  it('refuses when the tab has navigated away from the selection', async () => {
    const result = await runExplain({ text: 'word', url: 'https://elsewhere.example/' }, current);
    expect(result).toEqual({ ok: false, error: 'This page has changed. Select the text again.' });
    expect(getTabContext).not.toHaveBeenCalled();
  });

  it('turns server and network failures into readable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'OPENAI_API_KEY is not set.' }), { status: 503 })));
    expect(await runExplain({ text: 'w', url: current.url! }, current)).toEqual({ ok: false, error: 'OPENAI_API_KEY is not set.' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const offline = await runExplain({ text: 'w', url: current.url! }, current);
    expect(offline).toMatchObject({ ok: false, error: expect.stringContaining("Can't reach the Smart Tab Notes server") });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 422 })));
    expect(await runExplain({ text: 'w', url: current.url! }, current)).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
  });
});

describe('saved notes in the worker', () => {
  const page = tab(1, 'https://site1.example/article?utm_source=x', { title: 'Article' });
  const other = tab(2, 'https://site2.example/');
  // A content script caller: mayUse holds it to the frame that sent the
  // message, so the sender carries that frame's URL.
  const fromTab = (t: chrome.tabs.Tab): Caller =>
    ({ kind: 'tab', tab: t, sender: { tab: t, url: t.url }, origin: ORIGIN });
  const fromPage = fromTab(page);
  const fromOther = fromTab(other);
  const panel: Caller = { kind: 'panel' };
  const sentToTabs: unknown[] = [];

  beforeEach(async () => {
    await db.delete();
    await db.open();
    sentToTabs.length = 0;
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
      tabs: {
        query: vi.fn(async () => [page, other, tab(3, 'https://site1.example/article#later')]),
        sendMessage: vi.fn(async (tabId: number, message: unknown) => { sentToTabs.push([tabId, message]); return { ok: true }; }),
      },
    });
  });
  afterEach(async () => { vi.unstubAllGlobals(); await db.delete(); });

  const save = (caller: Caller, extra: Record<string, unknown> = {}) =>
    saveNote({ url: page.url!, title: 'ignored', text: ' quote ', ...extra } as never, caller);

  it('saves the quote, note and AI answer, cleaning what the page sent', async () => {
    const result = await save(fromPage, {
      note: ' mine ', explanation: 'It means.', question: 'Why?',
      sources: [{ title: 'Other', url: 'https://other.example/' }, { title: 'Bad', url: 'javascript:alert(1)' }],
      target: { quote: { exact: 'quote', prefix: '', suffix: '' } },
    });
    expect(result.ok).toBe(true);
    const stored = await getPageByUrl('https://site1.example/article');
    expect(stored?.title).toBe('Article'); // from the tab, not the payload
    const [note] = await listAnnotations(stored!.id);
    expect(note).toMatchObject({
      text: 'quote', note: 'mine', explanation: 'It means.', question: 'Why?',
      sources: [{ title: 'Other', url: 'https://other.example/' }], target: { quote: { exact: 'quote' } },
    });
  });

  it('tells side panels and other tabs on the same page, but not the tab that saved', async () => {
    await save(fromPage);
    await vi.waitFor(() => expect(sentToTabs).toHaveLength(1));
    expect((sentToTabs[0] as [number])[0]).toBe(3);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'annotations:changed', target: 'sidepanel' }));
  });

  it("keeps each page's notes to that page", async () => {
    expect(await save(fromOther)).toMatchObject({ ok: false });
    const saved = await save(fromPage);
    const id = saved.annotation!.id;

    expect((await listNotes(page.url!, fromOther)).annotations).toEqual([]);
    expect((await listNotes(page.url!, fromPage)).annotations).toHaveLength(1);
    expect((await listNotes(page.url!, panel)).annotations).toHaveLength(1);

    expect(await updateNote({ id, note: 'hijack' }, fromOther)).toMatchObject({ ok: false });
    expect(await deleteNote(id, fromOther)).toMatchObject({ ok: false });
    expect(await setAnchorState(id, true, fromOther)).toMatchObject({ ok: false });
    expect((await listNotes(page.url!, panel)).annotations[0]).toMatchObject({ text: 'quote' });
    expect((await listNotes(page.url!, panel)).annotations[0]!.note).toBeUndefined();

    // The side panel may delete any note.
    expect(await deleteNote(id, panel)).toEqual({ ok: true });
    expect((await listNotes(page.url!, panel)).annotations).toEqual([]);
  });

  it('edits a note, clears it with an empty string, and attaches an explanation', async () => {
    const id = (await save(fromPage, { note: 'first' })).annotation!.id;
    expect((await updateNote({ id, note: 'second' }, fromPage)).annotation).toMatchObject({ note: 'second' });
    const explained = await updateNote({
      id, explanation: 'Now explained.', sources: [{ title: 'T', url: 'https://t.example/' }],
    }, fromPage);
    // Leaving `note` out leaves it alone.
    expect(explained.annotation).toMatchObject({ note: 'second', explanation: 'Now explained.', sources: [{ title: 'T', url: 'https://t.example/' }] });
    expect((await updateNote({ id, note: '' }, panel)).annotation!.note).toBeUndefined();
  });

  it('refuses an empty quote and ignores fields of the wrong type', async () => {
    expect(await save(fromPage, { text: '  ' })).toMatchObject({ ok: false });
    const odd = await save(fromPage, { note: 42, sources: 'x', target: 'nope', explanation: ['x'] });
    expect(odd.ok).toBe(true);
    expect(odd.annotation).not.toHaveProperty('note');
    expect(odd.annotation).not.toHaveProperty('target');
    expect(odd.annotation).not.toHaveProperty('explanation');
  });

  it('only lets the side panel and tabs in', () => {
    const sender = { url: 'https://site1.example/', tab: page };
    expect(callerOf({ url: ORIGIN + 'sidepanel.html' }, ORIGIN)).toEqual({ kind: 'panel' });
    expect(callerOf(sender, ORIGIN)).toEqual({ kind: 'tab', tab: page, sender, origin: ORIGIN });
    expect(callerOf({ url: 'https://elsewhere.example/' }, ORIGIN)).toBeNull();
  });

  it('refuses a subframe that names the page its tab is showing', async () => {
    // The sending frame is an ad iframe; the tab is on site1. Checking the
    // tab's URL instead of the frame's would let the frame write site1's notes.
    const iframe: Caller = {
      kind: 'tab', tab: page, sender: { tab: page, url: 'https://ads.example/frame' }, origin: ORIGIN,
    };
    expect(await save(iframe)).toEqual({ ok: false, reason: 'This page has changed. Select the text again.' });
    expect(await getPageByUrl(page.url!)).toBeUndefined();
  });
});
