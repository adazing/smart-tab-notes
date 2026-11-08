// Provisional fields: no PRD is present. See README before extending this model.
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
  text: string;
  note?: string;
}

export interface ChatSummaryInput {
  pageId: string;
  summary: string;
}

export interface CollectionInput {
  name: string;
}

export interface Page extends RecordMetadata, PageInput {}
export interface Annotation extends RecordMetadata, AnnotationInput {}
export interface ChatSummary extends RecordMetadata, ChatSummaryInput {}
export interface Collection extends RecordMetadata, CollectionInput {}
export type AnnotationUpdate = Partial<Pick<AnnotationInput, 'text' | 'note'>>;
export interface StorageRecords {
  pages: Page;
  annotations: Annotation;
  chatSummaries: ChatSummary;
  collections: Collection;
}
