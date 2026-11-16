import { db } from './database';
import { normalizeUrl } from './normalize-url';
import type {
  Annotation, AnnotationInput, AnnotationUpdate, ChatSummary, ChatSummaryInput,
  Collection, CollectionInput, Page, PageInput, RecordMetadata, StorageRecords,
} from './storage-types';

export type * from './storage-types';
export { normalizeUrl } from './normalize-url';

function metadata(): RecordMetadata {
  const now = Date.now();
  return { id: crypto.randomUUID(), createdAt: now, updatedAt: now, deleted: false };
}

function modifiedAt(record: RecordMetadata): number {
  return Math.max(Date.now(), record.updatedAt + 1);
}

async function requirePage(pageId: string): Promise<void> {
  const page = await db.pages.get(pageId);
  if (!page || page.deleted) throw new Error(`Active page not found: ${pageId}`);
}

export async function savePage(input: PageInput): Promise<Page> {
  const url = normalizeUrl(input.url);
  return await db.transaction('rw', db.pages, async () => {
    const existing = await db.pages.where('url').equals(url).first();
    // Re-saving a tombstone explicitly restores the same record and UUID.
    const page: Page = existing
      ? { ...existing, title: input.title, deleted: false, updatedAt: modifiedAt(existing) }
      : { url, title: input.title, ...metadata() };
    await db.pages.put(page);
    return page;
  });
}

export async function getPageByUrl(url: string): Promise<Page | undefined> {
  // chrome://, file:// and other pages can never be saved, so they have no page.
  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch {
    return undefined;
  }
  const page = await db.pages.where('url').equals(normalized).first();
  return page?.deleted ? undefined : page;
}

export async function addAnnotation(input: AnnotationInput): Promise<Annotation> {
  return await db.transaction('rw', db.pages, db.annotations, async () => {
    await requirePage(input.pageId);
    // Explicit allowlist, as in updateAnnotation: untyped callers can't set metadata.
    const annotation: Annotation = { pageId: input.pageId, text: input.text, ...metadata() };
    if (input.note !== undefined) annotation.note = input.note;
    if (input.target !== undefined) annotation.target = input.target;
    if (input.explanation !== undefined) annotation.explanation = input.explanation;
    if (input.question !== undefined) annotation.question = input.question;
    if (input.sources !== undefined) {
      annotation.sources = input.sources.map(({ title, url }) => ({ title, url }));
    }
    await db.annotations.add(annotation);
    return annotation;
  });
}

/** An active annotation and the page it belongs to, or `undefined`. */
export async function getAnnotationWithPage(
  id: string,
): Promise<{ annotation: Annotation; page: Page } | undefined> {
  const annotation = await db.annotations.get(id);
  if (!annotation || annotation.deleted) return undefined;
  const page = await db.pages.get(annotation.pageId);
  return page ? { annotation, page } : undefined;
}

export async function listAnnotations(pageId: string): Promise<Annotation[]> {
  return await db.annotations.where('pageId').equals(pageId)
    .filter(record => !record.deleted).sortBy('createdAt');
}

export async function updateAnnotation(
  id: string, changes: AnnotationUpdate,
): Promise<Annotation | undefined> {
  return await db.transaction('rw', db.annotations, async () => {
    const existing = await db.annotations.get(id);
    if (!existing || existing.deleted) return undefined;
    // Explicit allowlist also protects metadata from untyped callers.
    const annotation: Annotation = { ...existing, updatedAt: modifiedAt(existing) };
    if (changes.text !== undefined) annotation.text = changes.text;
    if (Object.hasOwn(changes, 'note')) annotation.note = changes.note;
    if (Object.hasOwn(changes, 'target')) annotation.target = changes.target;
    if (Object.hasOwn(changes, 'explanation')) annotation.explanation = changes.explanation;
    if (Object.hasOwn(changes, 'question')) annotation.question = changes.question;
    if (Object.hasOwn(changes, 'sources')) {
      annotation.sources = changes.sources?.map(({ title, url }) => ({ title, url }));
    }
    await db.annotations.put(annotation);
    return annotation;
  });
}

/**
 * Record whether the last visit to the page could place this note's quote.
 *
 * Unlike the functions above this one does not advance `updatedAt`: an
 * anchoring result is derived from the page, not an edit by the user, and
 * every page load would otherwise reshuffle "recently changed" lists. It
 * writes nothing when the flag is already correct.
 *
 * Returns the stored value, or `undefined` for a missing or deleted note.
 */
export async function setAnnotationOrphaned(
  id: string, orphaned: boolean,
): Promise<boolean | undefined> {
  return await db.transaction('rw', db.annotations, async () => {
    const existing = await db.annotations.get(id);
    if (!existing || existing.deleted) return undefined;
    if ((existing.orphaned ?? false) === orphaned) return orphaned;
    await db.annotations.put({ ...existing, orphaned });
    return orphaned;
  });
}

export async function softDelete(table: keyof StorageRecords, id: string): Promise<boolean> {
  const records = db.table<StorageRecords[typeof table], string>(table);
  return await db.transaction('rw', records, async () => {
    const existing = await records.get(id);
    if (!existing || existing.deleted) return false;
    await records.put({ ...existing, deleted: true, updatedAt: modifiedAt(existing) });
    return true;
  });
}

export async function addChatSummary(input: ChatSummaryInput): Promise<ChatSummary> {
  return await db.transaction('rw', db.pages, db.chatSummaries, async () => {
    await requirePage(input.pageId);
    const summary: ChatSummary = { pageId: input.pageId, summary: input.summary, ...metadata() };
    await db.chatSummaries.add(summary);
    return summary;
  });
}

export async function listChatSummaries(pageId?: string): Promise<ChatSummary[]> {
  const query = pageId === undefined
    ? db.chatSummaries.toCollection()
    : db.chatSummaries.where('pageId').equals(pageId);
  return (await query.filter(record => !record.deleted).sortBy('createdAt')).reverse();
}

export async function createCollection(input: CollectionInput): Promise<Collection> {
  const collection: Collection = { name: input.name, ...metadata() };
  await db.collections.add(collection);
  return collection;
}

export async function listCollections(): Promise<Collection[]> {
  return await db.collections.orderBy('createdAt').filter(record => !record.deleted).toArray();
}
