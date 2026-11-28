import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../shared/database';
import { addAnnotation, addChatSummary, savePage, updateAnnotation } from '../shared/storage';
import { RECAP_CACHE_KEY, RECAP_SEEN_KEY } from '../shared/types';
import type { Caller } from './notes';
import { buildRecapRequest, checkRecap, fingerprint, getRecap, prune, RECAP_CACHE_SIZE } from './recap';

const ORIGIN = 'chrome-extension://abc/';
const URL = 'https://site1.example/article';
/** The same page as far as storage is concerned: hash and tracking params go. */
const DIRTY_URL = 'https://site1.example/article?utm_source=news#part-2';

const tab = { id: 1, url: URL, title: 'Article', windowId: 1, groupId: -1 } as chrome.tabs.Tab;
const fromPage: Caller = { kind: 'tab', tab, sender: { tab, url: URL }, origin: ORIGIN };
const fromOther: Caller = {
  kind: 'tab',
  tab: { ...tab, id: 2, url: 'https://elsewhere.example/' } as chrome.tabs.Tab,
  sender: { url: 'https://elsewhere.example/' },
  origin: ORIGIN,
};
const panel: Caller = { kind: 'panel' };

/** chrome.storage.session, as the worker uses it. */
let session: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

const RECAP_BODY = { recap: 'You read about attention.', points: ['You marked the first line.'] };

function respondWith(body: unknown, status = 200): void {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

/** Put a record at a known point in time, so lists have one order. */
async function stamp(note: { id: string }, createdAt: number): Promise<void> {
  await db.annotations.update(note.id, { createdAt });
}

async function stampSummary(summary: { id: string }, createdAt: number): Promise<void> {
  await db.chatSummaries.update(summary.id, { createdAt });
}

async function seedPage(): Promise<string> {
  const page = await savePage({ url: URL, title: 'Article' });
  return page.id;
}

function sentBody(call = 0): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[call] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  session = {};
  fetchMock = vi.fn();
  respondWith(RECAP_BODY);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: vi.fn(async () => ({})) },
      session: {
        get: vi.fn(async (key: string) => (key in session ? { [key]: session[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(session, items); }),
      },
    },
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.delete();
});

describe('offering a recap', () => {
  it('says nothing for a page with nothing saved, and does not mark it', async () => {
    expect(await checkRecap(URL, fromPage)).toEqual({ show: false, noteCount: 0, summaryCount: 0 });
    expect(session[RECAP_SEEN_KEY]).toBeUndefined();

    // Saving a note and coming back still gets the offer.
    const pageId = await seedPage();
    await addAnnotation({ pageId, text: 'first line' });
    expect(await checkRecap(URL, fromPage)).toEqual({ show: true, noteCount: 1, summaryCount: 0 });
  });

  it('offers once per page per session, then only reports the counts', async () => {
    const pageId = await seedPage();
    await addAnnotation({ pageId, text: 'first line' });
    await addChatSummary({ pageId, summary: 'You compared it with convolutions.' });

    expect(await checkRecap(DIRTY_URL, fromPage)).toEqual({ show: true, noteCount: 1, summaryCount: 1 });
    // A reload of the same page, hash and tracking params and all.
    expect(await checkRecap(URL, fromPage)).toEqual({ show: false, noteCount: 1, summaryCount: 1 });
    expect(Object.keys(session[RECAP_SEEN_KEY] as object)).toEqual([URL]);
  });

  it('counts chat summaries on their own', async () => {
    const pageId = await seedPage();
    await addChatSummary({ pageId, summary: 'You asked how attention scales.' });
    expect(await checkRecap(URL, fromPage)).toEqual({ show: true, noteCount: 0, summaryCount: 1 });
  });

  it('refuses a page asking about another page, and a URL that can never have notes', async () => {
    const pageId = await seedPage();
    await addAnnotation({ pageId, text: 'first line' });
    expect(await checkRecap(URL, fromOther)).toEqual({ show: false, noteCount: 0, summaryCount: 0 });
    expect(await checkRecap('chrome://settings', fromPage)).toEqual({ show: false, noteCount: 0, summaryCount: 0 });
    expect(await checkRecap(42, fromPage)).toEqual({ show: false, noteCount: 0, summaryCount: 0 });
    expect(session[RECAP_SEEN_KEY]).toBeUndefined();
  });
});

describe('building the recap', () => {
  it('sends the notes and chat summaries oldest first, and returns what came back', async () => {
    const pageId = await seedPage();
    // Spaced out in time, because notes made in the same millisecond have no
    // order of their own.
    await stamp(await addAnnotation({ pageId, text: 'first line', note: 'mine', question: 'Why?', explanation: 'Because.' }), 1);
    await stamp(await addAnnotation({ pageId, text: 'second line' }), 2);
    await stampSummary(await addChatSummary({ pageId, summary: 'Older chat' }), 1);
    await stampSummary(await addChatSummary({ pageId, summary: 'Newer chat' }), 2);

    const result = await getRecap({ url: DIRTY_URL }, panel);

    expect(result).toMatchObject({ ok: true, cached: false });
    expect(result.recap).toMatchObject({
      summary: 'You read about attention.',
      points: ['You marked the first line.'],
      noteCount: 2,
      summaryCount: 2,
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://localhost:8000/recap');
    expect(sentBody()).toEqual({
      title: 'Article',
      url: URL,
      notes: [
        { text: 'first line', note: 'mine', question: 'Why?', explanation: 'Because.' },
        { text: 'second line' },
      ],
      chat_summaries: ['Older chat', 'Newer chat'],
    });
  });

  it('reuses the recap until the page changes, and refresh rebuilds it anyway', async () => {
    const pageId = await seedPage();
    const note = await addAnnotation({ pageId, text: 'first line' });

    const built = await getRecap({ url: URL }, panel);
    expect(built).toMatchObject({ ok: true, cached: false });
    expect(await getRecap({ url: URL }, panel)).toMatchObject({ ok: true, cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Editing a note is a change; the next ask pays for a new recap.
    await updateAnnotation(note.id, { note: 'now with a note' });
    expect(await getRecap({ url: URL }, panel)).toMatchObject({ ok: true, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await getRecap({ url: URL }, panel)).toMatchObject({ ok: true, cached: true });

    expect(await getRecap({ url: URL, refresh: true }, panel)).toMatchObject({ ok: true, cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps at most RECAP_CACHE_SIZE pages', async () => {
    const pageId = await seedPage();
    await addAnnotation({ pageId, text: 'first line' });
    await getRecap({ url: URL }, panel);
    const cache: Record<string, unknown> = {};
    for (let i = 0; i < RECAP_CACHE_SIZE; i += 1) {
      cache[`https://filler${i}.example/`] = { recap: { builtAt: i }, fingerprint: 'x' };
    }
    session[RECAP_CACHE_KEY] = cache;
    await getRecap({ url: URL, refresh: true }, panel);
    const kept = Object.keys(session[RECAP_CACHE_KEY] as object);
    expect(kept).toHaveLength(RECAP_CACHE_SIZE);
    // The one just built is the newest, so it stays; the oldest filler goes.
    expect(kept).toContain(URL);
    expect(kept).not.toContain('https://filler0.example/');
  });

  it('refuses a page with nothing saved, and an unreachable URL', async () => {
    expect(await getRecap({ url: URL }, panel)).toEqual({ ok: false, reason: 'Nothing is saved on this page yet.' });
    expect(await getRecap({ url: 'chrome://settings' }, panel)).toMatchObject({ ok: false });
    expect(await getRecap({ url: URL }, fromOther)).toEqual({ ok: false, reason: 'Not this page.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a server error through as something to show, and does not cache it', async () => {
    const pageId = await seedPage();
    await addAnnotation({ pageId, text: 'first line' });
    respondWith({ detail: 'OPENAI_API_KEY is not set. Add it to backend/.env.' }, 503);
    expect(await getRecap({ url: URL }, panel)).toEqual({
      ok: false, reason: 'OPENAI_API_KEY is not set. Add it to backend/.env.',
    });
    expect(session[RECAP_CACHE_KEY]).toBeUndefined();

    respondWith({ recap: '   ', points: ['', '  '] });
    expect(await getRecap({ url: URL }, panel)).toEqual({ ok: false, reason: 'The recap came back empty. Try again.' });
    expect(session[RECAP_CACHE_KEY]).toBeUndefined();
  });

  it('caps the points it keeps', async () => {
    const pageId = await seedPage();
    await addAnnotation({ pageId, text: 'first line' });
    respondWith({ recap: 'A recap.', points: ['1', '2', '3', '4', '5', '6', '7'] });
    const result = await getRecap({ url: URL }, panel);
    expect(result.recap?.points).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('what a recap was built from', () => {
  it('changes with the notes and summaries, not with anchoring', async () => {
    const pageId = await seedPage();
    const note = await addAnnotation({ pageId, text: 'first line' });
    const first = fingerprint([note], []);
    expect(fingerprint([note], [])).toBe(first);
    expect(fingerprint([{ ...note, orphaned: true }], [])).toBe(first);
    expect(fingerprint([{ ...note, updatedAt: note.updatedAt + 1 }], [])).not.toBe(first);
    expect(fingerprint([], [])).not.toBe(first);
    const summary = await addChatSummary({ pageId, summary: 'A chat' });
    expect(fingerprint([note], [summary])).not.toBe(first);
  });

  it('caps the notes and the text of each one', () => {
    const page = { id: 'p', url: URL, title: 't', createdAt: 0, updatedAt: 0, deleted: false };
    const note = (text: string, extra = {}) => ({
      id: text, pageId: 'p', text, createdAt: 0, updatedAt: 0, deleted: false, ...extra,
    });
    const request = buildRecapRequest(
      page,
      [note('x'.repeat(20_050)), note('  '), note('kept', { note: 'n', explanation: 'e', question: 'q' })],
      [],
    );
    expect(request.notes).toHaveLength(2);
    expect(request.notes?.[0]?.text).toHaveLength(20_000);
    expect(request.notes?.[1]).toEqual({ text: 'kept', note: 'n', question: 'q', explanation: 'e' });
  });
});

describe('prune', () => {
  it('keeps the newest entries and leaves a short list alone', () => {
    const entries = { a: 3, b: 1, c: 2 };
    expect(prune(entries, 5, (at) => at)).toBe(entries);
    expect(prune(entries, 2, (at) => at)).toEqual({ a: 3, c: 2 });
  });
});
