/**
 * Building a POST /chat body from the tabs the user picked and the chat so
 * far, kept inside the backend's limits (CHAT_LIMITS, docs/api.md).
 */

import { CHAT_LIMITS, type ChatMessage, type ChatTab } from '../shared/api';
import type { TabContext } from '../shared/types';

/** How many earlier exchanges to send. The backend only uses the last 10 messages. */
export const HISTORY_TURNS = 5;

export const SKIP_REASONS: Record<TabContext['status'], string> = {
  ok: 'no readable text',
  not_loaded: 'not loaded yet (visit it once, then ask again)',
  restricted: "Chrome doesn't let extensions read it",
  pdf: "PDFs aren't supported yet",
  error: "couldn't be read",
};

export interface SkippedTab {
  tabId: number;
  title: string;
  reason: string;
}

/**
 * Readable tabs become ChatTabs; the rest are reported as skipped. Chunks are
 * kept in page order until a tab-count, chunk-count or total-size limit is hit.
 */
export function toChatTabs(contexts: TabContext[]): { tabs: ChatTab[]; skipped: SkippedTab[] } {
  const tabs: ChatTab[] = [];
  const skipped: SkippedTab[] = [];
  let chunkCount = 0;
  let chars = 0;
  for (const context of contexts) {
    const label = context.title || context.url || `Tab ${context.tabId}`;
    if (context.status !== 'ok' || context.chunks.length === 0) {
      skipped.push({ tabId: context.tabId, title: label, reason: SKIP_REASONS[context.status] });
      continue;
    }
    if (tabs.length >= CHAT_LIMITS.tabs) {
      skipped.push({ tabId: context.tabId, title: label, reason: `only ${CHAT_LIMITS.tabs} tabs fit in one question` });
      continue;
    }
    const chunks: ChatTab['chunks'] = [];
    for (const chunk of context.chunks) {
      const text = chunk.text.slice(0, CHAT_LIMITS.chunkChars);
      if (!text.trim()) continue;
      if (chunkCount >= CHAT_LIMITS.chunks || chars + text.length > CHAT_LIMITS.chunkCharsTotal) break;
      chunks.push({ id: chunk.id, heading: chunk.heading.slice(0, CHAT_LIMITS.heading), text });
      chunkCount += 1;
      chars += text.length;
    }
    if (chunks.length === 0) {
      skipped.push({ tabId: context.tabId, title: label, reason: 'too much text across the chosen tabs' });
      continue;
    }
    tabs.push({
      tab_id: context.tabId,
      title: context.title.slice(0, CHAT_LIMITS.tabTitle),
      url: context.url.slice(0, CHAT_LIMITS.tabUrl),
      chunks,
    });
  }
  return { tabs, skipped };
}

/** The last HISTORY_TURNS answered exchanges, then the new question. */
export function toChatMessages(history: { question: string; answer: string }[], question: string): ChatMessage[] {
  const clip = (text: string): string => text.slice(0, CHAT_LIMITS.messageChars);
  const messages: ChatMessage[] = history
    .filter((turn) => turn.question.trim() && turn.answer.trim())
    .slice(-HISTORY_TURNS)
    .flatMap((turn) => [
      { role: 'user' as const, content: clip(turn.question) },
      { role: 'assistant' as const, content: clip(turn.answer) },
    ]);
  messages.push({ role: 'user', content: clip(question) });
  return messages;
}

/** Query strings and fragments can hold tokens or emails; /rank-tabs only needs the page. */
export function urlForRanking(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '';
  }
}
