/**
 * The page recap, run in the background worker.
 *
 *   page loaded --recap:check--> worker (how much is saved here?)
 *   "See recap" --recap:open---> worker --> side panel
 *   side panel  --recap:get----> worker --POST /recap--> backend
 *
 * The worker owns this for the same reason it owns notes: a content script
 * cannot read the extension's IndexedDB, and must not be able to choose what
 * is sent to the backend. A page may only ask about itself (`mayUse`).
 *
 * Two pieces of state live in chrome.storage.session, which content scripts
 * cannot reach and which empties when the browser session does:
 *   - which pages have already offered a recap, so the offer is made once
 *     per page per session, whether it was taken up or dismissed;
 *   - the recaps built so far, each with a fingerprint of the notes and chat
 *     summaries it was built from. A recap is reused until one of those
 *     changes, so reopening the panel does not pay for the same answer twice.
 */

import { ApiError, postRecap, RECAP_LIMITS, type RecapNote, type RecapRequest } from '../shared/api';
import { normalizeUrl } from '../shared/normalize-url';
import {
  getPageByUrl,
  listAnnotations,
  listChatSummaries,
  type Annotation,
  type ChatSummary,
  type Page,
} from '../shared/storage';
import type { RequestOf, ResponseOf } from '../shared/messages';
import { RECAP_CACHE_KEY, RECAP_SEEN_KEY, type PageRecap } from '../shared/types';
import { mayUse, type Caller } from './notes';

const LOG = '[smart-tab-notes:recap]';

/** Recaps kept at once. Each is a few hundred words. */
export const RECAP_CACHE_SIZE = 20;
/** Pages remembered as "already offered" at once. */
export const RECAP_SEEN_SIZE = 300;

/** The most points a recap shows, matching the backend's own cap. */
const MAX_POINTS = 5;

interface CacheEntry {
  recap: PageRecap;
  /** The notes and summaries the recap was built from. */
  fingerprint: string;
}

/** The URL in the form storage uses, or null for a page that can never have notes. */
function normalized(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

async function readSession<T>(key: string): Promise<Record<string, T>> {
  try {
    const stored = (await chrome.storage.session.get(key))[key];
    return typeof stored === 'object' && stored !== null ? (stored as Record<string, T>) : {};
  } catch (error) {
    console.warn(LOG, 'could not read', key, error);
    return {};
  }
}

async function writeSession(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (error) {
    console.warn(LOG, 'could not write', key, error);
  }
}

/** Keep the `limit` newest entries, by whatever time `at` reads off each one. */
export function prune<T>(entries: Record<string, T>, limit: number, at: (value: T) => number): Record<string, T> {
  const keys = Object.keys(entries);
  if (keys.length <= limit) return entries;
  return Object.fromEntries(
    keys
      .sort((a, b) => at(entries[b] as T) - at(entries[a] as T))
      .slice(0, limit)
      .map((key) => [key, entries[key] as T]),
  );
}

/** Everything a recap is built from, oldest first. */
async function readPage(url: string): Promise<{ page?: Page; notes: Annotation[]; summaries: ChatSummary[] }> {
  const page = await getPageByUrl(url);
  if (!page) return { notes: [], summaries: [] };
  const [notes, summaries] = await Promise.all([listAnnotations(page.id), listChatSummaries(page.id)]);
  // listChatSummaries answers newest first; a recap reads better in the
  // order the reader made things, like the notes beside them.
  return { page, notes, summaries: summaries.slice().reverse() };
}

/**
 * What a recap was built from, as one string.
 *
 * Every id and `updatedAt` goes in, so editing a note, adding one, deleting
 * one or holding a chat all change it. Anchoring does not: it leaves
 * `updatedAt` alone, and whether a quote could be found on the page says
 * nothing about what the reader learned.
 */
export function fingerprint(notes: Annotation[], summaries: ChatSummary[]): string {
  const stamp = (record: { id: string; updatedAt: number }): string => `${record.id}:${record.updatedAt}`;
  return [notes.length, summaries.length, ...notes.map(stamp), ...summaries.map(stamp)].join('|');
}

/** The /recap body for one page's notes and chat summaries, capped field by field. */
export function buildRecapRequest(page: Page, notes: Annotation[], summaries: ChatSummary[]): RecapRequest {
  return {
    title: page.title.slice(0, RECAP_LIMITS.title),
    url: page.url.slice(0, RECAP_LIMITS.url),
    notes: notes
      .filter((note) => note.text.trim())
      .slice(0, RECAP_LIMITS.notes)
      .map((note) => {
        const sent: RecapNote = { text: note.text.slice(0, RECAP_LIMITS.noteText) };
        if (note.note) sent.note = note.note.slice(0, RECAP_LIMITS.note);
        if (note.question) sent.question = note.question.slice(0, RECAP_LIMITS.question);
        if (note.explanation) sent.explanation = note.explanation.slice(0, RECAP_LIMITS.explanation);
        return sent;
      }),
    chat_summaries: summaries
      .filter((summary) => summary.summary.trim())
      .slice(0, RECAP_LIMITS.summaries)
      .map((summary) => summary.summary.slice(0, RECAP_LIMITS.summaryChars)),
  };
}

/**
 * Is there anything saved on `url`, and should the page offer a recap?
 *
 * Answering yes is also the record that the offer was made: a page that
 * asked once is not asked again this session, so a reload does not bring
 * the popup back, whether the reader opened the recap or dismissed it. A
 * page with nothing saved is not marked, so saving a note and coming back
 * still gets the offer.
 */
export async function checkRecap(url: unknown, caller: Caller): Promise<ResponseOf<'recap:check'>> {
  const nothing = { show: false, noteCount: 0, summaryCount: 0 };
  if (typeof url !== 'string' || !mayUse(caller, url)) return nothing;
  const key = normalized(url);
  if (!key) return nothing;
  try {
    const { notes, summaries } = await readPage(key);
    const counts = { noteCount: notes.length, summaryCount: summaries.length };
    if (counts.noteCount + counts.summaryCount === 0) return { show: false, ...counts };

    const seen = await readSession<number>(RECAP_SEEN_KEY);
    if (seen[key] !== undefined) return { show: false, ...counts };
    await writeSession(RECAP_SEEN_KEY, prune({ ...seen, [key]: Date.now() }, RECAP_SEEN_SIZE, (at) => at));
    return { show: true, ...counts };
  } catch (error) {
    console.warn(LOG, 'could not check for a recap:', error);
    return nothing;
  }
}

/**
 * The recap for `url`: the cached one while the page's notes and chat
 * summaries are unchanged, otherwise a fresh one from POST /recap.
 * `refresh` builds a new one either way.
 */
export async function getRecap(
  request: RequestOf<'recap:get'>,
  caller: Caller,
): Promise<ResponseOf<'recap:get'>> {
  if (typeof request?.url !== 'string' || !mayUse(caller, request.url)) {
    return { ok: false, reason: 'Not this page.' };
  }
  const key = normalized(request.url);
  if (!key) return { ok: false, reason: 'This page cannot have notes.' };

  try {
    const { page, notes, summaries } = await readPage(key);
    if (!page || notes.length + summaries.length === 0) {
      return { ok: false, reason: 'Nothing is saved on this page yet.' };
    }

    const print = fingerprint(notes, summaries);
    const cache = await readSession<CacheEntry>(RECAP_CACHE_KEY);
    const cached = cache[key];
    if (request.refresh !== true && cached?.fingerprint === print) {
      return { ok: true, recap: cached.recap, cached: true };
    }

    const response = await postRecap(buildRecapRequest(page, notes, summaries));
    const recap: PageRecap = {
      summary: typeof response.recap === 'string' ? response.recap.trim() : '',
      points: (Array.isArray(response.points) ? response.points : [])
        .filter((point): point is string => typeof point === 'string' && point.trim() !== '')
        .slice(0, MAX_POINTS),
      noteCount: notes.length,
      summaryCount: summaries.length,
      builtAt: Date.now(),
    };
    // Nothing to show is not worth keeping, and saying "here is your recap"
    // over an empty card is worse than saying it did not work.
    if (!recap.summary && recap.points.length === 0) {
      return { ok: false, reason: 'The recap came back empty. Try again.' };
    }

    await writeSession(
      RECAP_CACHE_KEY,
      prune({ ...cache, [key]: { recap, fingerprint: print } }, RECAP_CACHE_SIZE, (entry) => entry.recap.builtAt),
    );
    return { ok: true, recap, cached: false };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, reason: error.message };
    console.error(LOG, 'recap failed:', error);
    return { ok: false, reason: 'Something went wrong. Try again.' };
  }
}
