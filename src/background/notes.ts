/**
 * Saved notes (highlights), run in the background worker: the one place
 * notes are written. Content scripts can't use the extension's IndexedDB,
 * so the page's annotation layer and the side panel both come here.
 *
 * Who may do what:
 *   - the side panel (an extension page) may read and change any note;
 *   - a content script may only touch notes on its own tab's page, because
 *     it runs inside a web page, the least trusted part of the extension.
 *
 * Every field from a content script is checked and capped, not trusted.
 */

import { sendToTab, notify, type RequestOf, type ResponseOf } from '../shared/messages';
import { isFromExtensionPage, isFromTab, mayReachUrl } from '../shared/senders';
import {
  addAnnotation,
  getAnnotationWithPage,
  getPageByUrl,
  listAnnotations,
  savePage,
  setAnnotationOrphaned,
  softDelete,
  updateAnnotation,
  type AnnotationSource,
  type AnnotationUpdate,
} from '../shared/storage';
import type { AnnotationTarget } from '../shared/types';
import { samePage } from './explain';

export const NOTE_LIMITS = {
  text: 20_000, note: 10_000, explanation: 10_000, question: 2_000, sources: 20, title: 1_000, url: 4_096,
} as const;

const LOG = '[smart-tab-notes:notes]';

/**
 * Who sent a notes message. A tab caller keeps the sender it was built
 * from, because the frame that sent the message is what `mayUse` holds it
 * to -- not the tab it sits in.
 */
export type Caller =
  | { kind: 'panel' }
  | { kind: 'tab'; tab: chrome.tabs.Tab; sender: chrome.runtime.MessageSender; origin: string };

export function callerOf(sender: chrome.runtime.MessageSender, origin: string): Caller | null {
  if (isFromExtensionPage(sender, origin)) return { kind: 'panel' };
  if (isFromTab(sender, origin) && sender.tab) return { kind: 'tab', tab: sender.tab, sender, origin };
  return null;
}

/**
 * May `caller` touch notes on `url`?
 *
 * The URL arrives in the payload, so it says nothing about who is asking.
 * `mayReachUrl` compares it with `sender.url`, the sending frame as the
 * browser saw it, rather than with the tab's own URL: a content script in a
 * subframe would otherwise pass by naming the page its tab happens to show.
 * The side panel passes the URL of whichever tab it is showing, so it keeps
 * any.
 */
function mayUse(caller: Caller, url: string): boolean {
  return caller.kind === 'panel' || mayReachUrl(caller.sender, url, caller.origin);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function sources(value: unknown): AnnotationSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = value
    .filter((s): s is { title: unknown; url: unknown } => typeof s === 'object' && s !== null)
    .filter((s) => typeof s.url === 'string' && /^https?:\/\//.test(s.url))
    .slice(0, NOTE_LIMITS.sources)
    .map((s) => ({
      title: typeof s.title === 'string' ? s.title.slice(0, NOTE_LIMITS.title) : '',
      url: (s.url as string).slice(0, NOTE_LIMITS.url),
    }));
  return clean.length ? clean : undefined;
}

function target(value: unknown): AnnotationTarget | undefined {
  // Built by textIndex.targetFromRange; anchoring tolerates odd values, so
  // only check it is the right kind of thing.
  if (typeof value !== 'object' || value === null) return undefined;
  const quote = (value as { quote?: { exact?: unknown } }).quote;
  return typeof quote?.exact === 'string' ? (value as AnnotationTarget) : undefined;
}

/**
 * Tell side panels, and every other tab showing `url`, that its notes
 * changed. `except` is the tab that made the change: it already knows.
 */
export async function announceChange(url: string, except?: number): Promise<void> {
  await notify('sidepanel', 'annotations:changed', { url });
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs
      .filter((tab) => tab.id !== undefined && tab.id !== except && samePage(tab.url, url))
      .map((tab) => sendToTab(tab.id!, 'annotations:changed', { url })));
  } catch (error) {
    console.warn(LOG, 'could not tell tabs about a change:', error);
  }
}

type Reply<K extends 'annotations:save' | 'annotations:update'> = ResponseOf<K>;

export async function saveNote(request: RequestOf<'annotations:save'>, caller: Caller): Promise<Reply<'annotations:save'>> {
  // Store against the URL `mayUse` just checked -- the sending frame's --
  // not the tab's, which for a subframe is a page this sender never proved
  // it was on.
  const url = caller.kind === 'tab' ? caller.sender.url ?? '' : String(request.url ?? '');
  if (!mayUse(caller, String(request.url ?? ''))) {
    return { ok: false, reason: 'This page has changed. Select the text again.' };
  }
  const quote = text(request.text, NOTE_LIMITS.text);
  if (!quote) return { ok: false, reason: 'Nothing to save: the selection is empty.' };
  try {
    const title = caller.kind === 'tab' ? caller.tab.title ?? '' : String(request.title ?? '');
    const page = await savePage({ url, title: title.slice(0, NOTE_LIMITS.title) });
    const input: Parameters<typeof addAnnotation>[0] = { pageId: page.id, text: quote };
    const note = text(request.note, NOTE_LIMITS.note);
    const where = target(request.target);
    const explanation = text(request.explanation, NOTE_LIMITS.explanation);
    const question = text(request.question, NOTE_LIMITS.question);
    const from = sources(request.sources);
    if (note) input.note = note;
    if (where) input.target = where;
    if (explanation) input.explanation = explanation;
    if (explanation && question) input.question = question;
    if (explanation && from) input.sources = from;
    const annotation = await addAnnotation(input);
    void announceChange(url, caller.kind === 'tab' ? caller.tab.id : undefined);
    return { ok: true, annotation };
  } catch (error) {
    console.warn(LOG, 'could not save a note:', error);
    return { ok: false, reason: describe(error) };
  }
}

export async function listNotes(url: string, caller: Caller): Promise<ResponseOf<'annotations:list'>> {
  if (!mayUse(caller, url)) return { annotations: [], reason: 'Not this page.' };
  try {
    const page = await getPageByUrl(url);
    return { annotations: page ? await listAnnotations(page.id) : [] };
  } catch (error) {
    console.warn(LOG, 'could not read notes:', error);
    return { annotations: [], reason: describe(error) };
  }
}

/** The note `id`, if `caller` may touch it. */
async function owned(id: string, caller: Caller) {
  if (typeof id !== 'string') return undefined;
  const found = await getAnnotationWithPage(id);
  return found && mayUse(caller, found.page.url) ? found : undefined;
}

export async function updateNote(request: RequestOf<'annotations:update'>, caller: Caller): Promise<Reply<'annotations:update'>> {
  try {
    const found = await owned(request.id, caller);
    if (!found) return { ok: false, reason: 'This note no longer exists.' };
    const changes: AnnotationUpdate = {};
    // '' clears the note; a missing field leaves it alone.
    if (typeof request.note === 'string') changes.note = text(request.note, NOTE_LIMITS.note);
    const explanation = text(request.explanation, NOTE_LIMITS.explanation);
    if (explanation) {
      // A new answer replaces the old one together with what it answered.
      changes.explanation = explanation;
      changes.question = text(request.question, NOTE_LIMITS.question);
      changes.sources = sources(request.sources);
    }
    const annotation = await updateAnnotation(request.id, changes);
    if (!annotation) return { ok: false, reason: 'This note no longer exists.' };
    void announceChange(found.page.url, caller.kind === 'tab' ? caller.tab.id : undefined);
    return { ok: true, annotation };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}

export async function deleteNote(id: string, caller: Caller): Promise<ResponseOf<'annotations:delete'>> {
  try {
    const found = await owned(id, caller);
    if (!found || !(await softDelete('annotations', id))) return { ok: false, reason: 'This note no longer exists.' };
    void announceChange(found.page.url, caller.kind === 'tab' ? caller.tab.id : undefined);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}

export async function setAnchorState(id: string, orphaned: boolean, caller: Caller): Promise<ResponseOf<'annotations:anchorState'>> {
  try {
    const found = await owned(id, caller);
    if (!found || typeof orphaned !== 'boolean') return { ok: false, reason: 'This note no longer exists.' };
    await setAnnotationOrphaned(id, orphaned);
    // The side panel shows "not found on the page"; tabs don't care.
    await notify('sidepanel', 'annotations:changed', { url: found.page.url });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}
