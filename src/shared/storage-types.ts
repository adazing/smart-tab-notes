// Provisional fields: no PRD is present. See README before extending this model.
import type { AnnotationTarget } from './types';

export interface RecordMetadata {
  id: string;
  /** UTC milliseconds since the Unix epoch. */
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export interface PageInput {
  url: string;
  title: string;
}

export interface AnnotationInput {
  pageId: string;
  /** The highlighted text, for display in lists that have no page open. */
  text: string;
  note?: string;
  /**
   * Quote, surrounding text and character offsets, so the highlight can be
   * found again after the page changes. Optional: callers that cannot build
   * one (no DOM, a PDF) still get a saved note, it just never re-anchors.
   */
  target?: AnnotationTarget;
  /** The AI explanation shown with the note. Filled in by the explain flow. */
  explanation?: string;
}

export interface ChatSummaryInput {
  pageId: string;
  summary: string;
}

export interface CollectionInput {
  name: string;
}

export interface Page extends RecordMetadata, PageInput {}
export interface Annotation extends RecordMetadata, AnnotationInput {
  /**
   * True when the last visit to the page could not place the quote, so the
   * note is kept but not drawn. Derived state: set by the anchoring pass,
   * not by the user, and cleared as soon as the quote turns up again.
   */
  orphaned?: boolean;
}
export interface ChatSummary extends RecordMetadata, ChatSummaryInput {}
export interface Collection extends RecordMetadata, CollectionInput {}
export type AnnotationUpdate = Partial<
  Pick<AnnotationInput, 'text' | 'note' | 'target' | 'explanation'>
>;
export interface StorageRecords {
  pages: Page;
  annotations: Annotation;
  chatSummaries: ChatSummary;
  collections: Collection;
}
