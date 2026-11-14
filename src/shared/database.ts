import Dexie, { type Table } from 'dexie';
import type { Annotation, ChatSummary, Collection, Page } from './storage-types';

// Internal module: extension consumers should import storage.ts instead.
export class StorageDatabase extends Dexie {
  declare pages: Table<Page, string>;
  declare annotations: Table<Annotation, string>;
  declare chatSummaries: Table<ChatSummary, string>;
  declare collections: Table<Collection, string>;

  constructor(name = 'smart-tab-notes') {
    super(name);
    this.version(1).stores({
      pages: 'id, &url, updatedAt',
      annotations: 'id, pageId, updatedAt',
      chatSummaries: 'id, pageId, createdAt, updatedAt',
      collections: 'id, createdAt, updatedAt',
    });
  }
}

export const db = new StorageDatabase();
