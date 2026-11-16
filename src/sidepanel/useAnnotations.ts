/**
 * The saved notes for the page in view, read straight from storage (the side
 * panel shares the worker's origin, so it sees the same IndexedDB).
 *
 * Reloads when the URL changes and when the worker sends
 * `annotations:changed` for this page (a Save from the toolbar).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { onMessage } from '../shared/messages';
import { getPageByUrl, listAnnotations, normalizeUrl, type Annotation } from '../shared/storage';

export interface AnnotationsState {
  annotations: Annotation[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function sameUrl(a: string, b: string): boolean {
  try {
    return normalizeUrl(a) === normalizeUrl(b);
  } catch {
    return false;
  }
}

export function useAnnotations(url: string | null): AnnotationsState {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;
  // Only the latest load may update state.
  const requestRef = useRef(0);

  const reload = useCallback(() => {
    const request = ++requestRef.current;
    const target = urlRef.current;
    if (!target) {
      setAnnotations([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const page = await getPageByUrl(target);
        const list = page ? await listAnnotations(page.id) : [];
        if (request === requestRef.current) setAnnotations(list);
      } catch (cause) {
        console.error('[smart-tab-notes:sidepanel] loading notes failed:', cause);
        if (request === requestRef.current) setError('Could not load notes for this page.');
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    setAnnotations([]);
    reload();
  }, [url, reload]);

  useEffect(() => {
    return onMessage('sidepanel', 'annotations:changed', (event) => {
      if (urlRef.current && sameUrl(event.url, urlRef.current)) reload();
      return { ok: true };
    });
  }, [reload]);

  return { annotations, loading, error, reload };
}
