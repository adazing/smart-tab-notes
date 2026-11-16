/**
 * The side panel chat: a list of turns, each a question asked over a set of
 * tabs and its streamed answer.
 *
 * Sending reads the chosen tabs (tabs:getContext, the one read path), then
 * streams POST /chat. Tabs are only read when the user sends.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, streamChat, type Citation } from '../shared/api';
import { sendToBackground } from '../shared/messages';
import { toChatMessages, toChatTabs, type SkippedTab } from './chatRequest';

export type TurnStatus = 'reading' | 'thinking' | 'streaming' | 'done' | 'stopped' | 'error';

export interface Turn {
  id: number;
  question: string;
  status: TurnStatus;
  /** The answer so far, `[chunk_id]` markers included. */
  answer: string;
  /** From the done event; null until then. */
  citations: Citation[] | null;
  /** False when the tabs didn't cover the question. */
  covered: boolean | null;
  error: string | null;
  /** Every chunk id sent, and the tab each belongs to, for chips while streaming. */
  chunkTabs: Map<string, { tabId: number; title: string; url: string }>;
  skipped: SkippedTab[];
}

export interface ChatState {
  turns: Turn[];
  busy: boolean;
  send: (question: string, tabIds: number[]) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

export function useChat(): ChatState {
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  const update = useCallback((id: number, change: (turn: Turn) => Partial<Turn>) => {
    setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, ...change(turn) } : turn)));
  }, []);

  const send = useCallback(async (question: string, tabIds: number[]) => {
    const text = question.trim();
    if (!text || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const id = nextId.current++;
    const history = turnsRef.current
      .filter((turn) => turn.status === 'done' || turn.status === 'stopped')
      .map((turn) => ({ question: turn.question, answer: turn.answer }));
    setTurns((all) => [...all, {
      id, question: text, status: 'reading', answer: '', citations: null, covered: null,
      error: null, chunkTabs: new Map(), skipped: [],
    }]);

    try {
      const read = await sendToBackground('tabs:getContext', { tabIds });
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!read.ok) throw new ApiError('Could not read the chosen tabs. Try again.', 0);
      const { tabs, skipped } = toChatTabs(read.data.contexts);
      const chunkTabs = new Map(
        tabs.flatMap((tab) => tab.chunks.map((chunk) => [chunk.id, { tabId: tab.tab_id, title: tab.title, url: tab.url }] as const)),
      );
      update(id, () => ({ status: 'thinking', chunkTabs, skipped }));
      if (tabs.length === 0) {
        throw new ApiError(
          tabIds.length ? 'None of the chosen tabs could be read.' : 'Pick at least one tab to ask about.', 0,
        );
      }

      const done = await streamChat(
        { messages: toChatMessages(history, text), tabs },
        {
          signal: controller.signal,
          onToken: (piece) => update(id, (turn) => ({ status: 'streaming', answer: turn.answer + piece })),
        },
      );
      update(id, (turn) => ({
        status: 'done', answer: done.answer || turn.answer, citations: done.citations ?? [], covered: done.covered,
      }));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        update(id, () => ({ status: 'stopped' }));
      } else {
        const message = error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
        if (!(error instanceof ApiError)) console.error('[smart-tab-notes:chat]', error);
        update(id, () => ({ status: 'error', error: message }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [update]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
  }, []);

  // Stop streaming if the panel closes.
  useEffect(() => () => abortRef.current?.abort(), []);

  const last = turns.at(-1);
  const busy = !!last && (last.status === 'reading' || last.status === 'thinking' || last.status === 'streaming');
  return { turns, busy, send, stop, clear };
}
