import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, StorageDatabase } from './database';
import {
  addAnnotation, addChatSummary, createCollection, getPageByUrl, listAnnotations,
  listChatSummaries, listCollections, normalizeUrl, savePage, softDelete, updateAnnotation,
} from './storage';

beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(async () => { await db.delete(); });

describe('database', () => {
  it('opens version one with four tables and intended indexes', () => {
    expect(db.isOpen()).toBe(true);
    expect(db.verno).toBe(1);
    expect(db.tables.map(table => table.name).sort()).toEqual([
      'annotations', 'chatSummaries', 'collections', 'pages',
    ]);
    expect(db.pages.schema.indexes.find(index => index.name === 'url')?.unique).toBe(true);
    expect(db.annotations.schema.idxByName.pageId).toBeDefined();
    expect(db.chatSummaries.schema.idxByName.pageId).toBeDefined();
  });

  it('persists through closing and reopening a separate connection', async () => {
    const page = await savePage({ url: 'https://example.com', title: 'Example' });
    db.close();
    const connection = new StorageDatabase();
    try {
      await connection.open();
      expect(await connection.pages.get(page.id)).toEqual(page);
    } finally { connection.close(); }
  });
});

describe('pages', () => {
  it('saves and retrieves metadata and normalized URLs', async () => {
    const page = await savePage({ url: 'https://example.com/a/?utm_source=x#b', title: 'A' });
    expect(page.url).toBe('https://example.com/a');
    expect(page.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.createdAt).toBe(page.updatedAt);
    expect(page.deleted).toBe(false);
    expect(await getPageByUrl('https://example.com/a?fbclid=y')).toEqual(page);
    expect(await getPageByUrl('https://example.com/missing')).toBeUndefined();
  });

  it('updates without duplicates and preserves creation metadata', async () => {
    const first = await savePage({ url: 'https://example.com/a', title: 'Old' });
    const updated = await savePage({ url: 'https://example.com/a/?UTM_source=x', title: 'New' });
    expect(updated).toMatchObject({ id: first.id, createdAt: first.createdAt, title: 'New' });
    expect(updated.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(await db.pages.count()).toBe(1);
  });

  it('serializes concurrent saves and restores tombstones', async () => {
    const input = { url: 'https://example.com', title: 'Example' };
    const [a, b] = await Promise.all([savePage(input), savePage(input)]);
    expect(a.id).toBe(b.id);
    await softDelete('pages', a.id);
    expect(await getPageByUrl(input.url)).toBeUndefined();
    const restored = await savePage(input);
    expect(restored.id).toBe(a.id);
    expect(restored.createdAt).toBe(a.createdAt);
    expect(restored.deleted).toBe(false);
  });
});

describe('annotations', () => {
  it('lists by page and updates only mutable fields', async () => {
    const page = await savePage({ url: 'https://example.com', title: 'Example' });
    const annotation = await addAnnotation({ pageId: page.id, text: 'Highlight', note: 'Note' });
    expect(await listAnnotations(page.id)).toEqual([annotation]);
    expect(await listAnnotations('missing')).toEqual([]);
    const patch = { text: 'Changed', note: '', id: 'tamper', createdAt: 0, pageId: 'tamper', deleted: true };
    const updated = await updateAnnotation(annotation.id, patch);
    expect(updated).toMatchObject({ ...annotation, text: 'Changed', note: '', updatedAt: expect.any(Number) });
    expect(updated!.updatedAt).toBeGreaterThan(annotation.updatedAt);
    expect(await updateAnnotation('missing', {})).toBeUndefined();
    await softDelete('annotations', annotation.id);
    expect(await listAnnotations(page.id)).toEqual([]);
    expect(await updateAnnotation(annotation.id, { text: 'No' })).toBeUndefined();
  });

  it('rejects missing or deleted parent pages without inserting children', async () => {
    await expect(addAnnotation({ pageId: 'missing', text: 'Text' })).rejects.toThrow('Active page not found');
    const page = await savePage({ url: 'https://example.com', title: 'Example' });
    await softDelete('pages', page.id);
    await expect(addChatSummary({ pageId: page.id, summary: 'Summary' })).rejects.toThrow('Active page not found');
    expect(await db.annotations.count()).toBe(0);
    expect(await db.chatSummaries.count()).toBe(0);
  });
});

describe('summaries and collections', () => {
  it('lists summaries newest first and filters by page', async () => {
    expect(await listChatSummaries()).toEqual([]);
    const page = await savePage({ url: 'https://example.com', title: 'Example' });
    const first = await addChatSummary({ pageId: page.id, summary: 'First' });
    // Explicit times avoid depending on wall-clock resolution for ordering.
    await db.chatSummaries.update(first.id, { createdAt: 1 });
    const second = await addChatSummary({ pageId: page.id, summary: 'Second' });
    expect((await listChatSummaries(page.id)).map(record => record.id)).toEqual([second.id, first.id]);
    expect(await listChatSummaries('missing')).toEqual([]);
    await softDelete('chatSummaries', second.id);
    expect((await listChatSummaries()).map(record => record.id)).toEqual([first.id]);
  });

  it('lists collections oldest first and excludes tombstones', async () => {
    expect(await listCollections()).toEqual([]);
    const first = await createCollection({ name: 'First' });
    await db.collections.update(first.id, { createdAt: 1 });
    const second = await createCollection({ name: 'Second' });
    expect((await listCollections()).map(record => record.id)).toEqual([first.id, second.id]);
    await softDelete('collections', first.id);
    expect(await listCollections()).toEqual([second]);
  });
});

describe('soft deletion', () => {
  it('retains all record types, advances timestamps, and never cascades', async () => {
    const page = await savePage({ url: 'https://example.com', title: 'Example' });
    const annotation = await addAnnotation({ pageId: page.id, text: 'Text' });
    const summary = await addChatSummary({ pageId: page.id, summary: 'Summary' });
    const collection = await createCollection({ name: 'Collection' });
    await softDelete('pages', page.id);
    expect(await listAnnotations(page.id)).toEqual([annotation]);
    expect(await listChatSummaries(page.id)).toEqual([summary]);
    for (const [table, record] of [
      ['pages', page], ['annotations', annotation], ['chatSummaries', summary], ['collections', collection],
    ] as const) {
      if (table !== 'pages') expect(await softDelete(table, record.id)).toBe(true);
      const stored = await db.table(table).get(record.id);
      expect(stored.deleted).toBe(true);
      expect(stored.updatedAt).toBeGreaterThan(record.updatedAt);
      expect(stored.createdAt).toBe(record.createdAt);
      expect(await softDelete(table, record.id)).toBe(false);
      expect(await softDelete(table, 'missing')).toBe(false);
    }
  });

  it('propagates database failures', async () => {
    db.close({ disableAutoOpen: true });
    await expect(listCollections()).rejects.toThrow();
  });
});

describe('URL normalization', () => {
  it.each([
    ['https://EXAMPLE.com/article/?utm_source=google#section2', 'https://example.com/article'],
    ['https://example.com/search?q=typescript&utm_campaign=test', 'https://example.com/search?q=typescript'],
    ['https://example.com/?UTM_SOURCE=a&fbclid=b&gclid=c&msclkid=d&mc_eid=e', 'https://example.com/'],
    ['https://example.com/a/b///#hash', 'https://example.com/a/b'],
    ['https://example.com', 'https://example.com/'],
    ['http://EXAMPLE.com/Path?id=1&id=2&ref=book', 'http://example.com/Path?id=1&id=2&ref=book'],
    ['https://example.com/a%2Fb?q=x%2Fy', 'https://example.com/a%2Fb?q=x%2Fy'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
    expect(normalizeUrl(expected)).toBe(expected);
  });

  it.each(['bad URL', '/relative', 'file:///tmp/file', 'javascript:alert(1)'])('rejects %s', input => {
    expect(() => normalizeUrl(input)).toThrow(TypeError);
  });
});
