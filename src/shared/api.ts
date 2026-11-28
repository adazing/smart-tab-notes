/**
 * Client for the Python backend. Request and response shapes follow
 * docs/api.md; keep the two in step.
 *
 * Every call throws `ApiError` with a message that can be shown to the user
 * as-is.
 */

import { getApiBaseUrl } from './config';
import { readSse } from './sse';

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the server could not be reached. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turn a FastAPI error body into one readable line. */
async function errorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    // Not JSON.
  }
  return undefined;
}

/** Messages for each status, used when the server gives no `detail` string. */
function statusMessage(status: number): string {
  if (status === 422) return 'The request was too large or malformed. Try a shorter selection.';
  if (status === 503) return 'The server is not configured. Check backend/.env.';
  return `The server returned an error (${status}). Try again.`;
}

/**
 * fetch() that throws ApiError for network failures, timeouts and non-2xx
 * responses. `path` starts with a slash.
 */
export async function apiFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const base = await getApiBaseUrl();
  const { timeoutMs, signal, ...rest } = init;
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
    (s): s is AbortSignal => s !== undefined && s !== null,
  );
  let response: Response;
  try {
    response = await fetch(base + path, {
      ...rest,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError('The server took too long to answer. Try again.', 0);
    }
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(`Can't reach the Smart Tab Notes server at ${base}. Is it running?`, 0);
  }
  if (!response.ok) {
    // 422 bodies are FastAPI's validation list, not a readable sentence.
    const detail = response.status === 422 ? undefined : await errorDetail(response);
    throw new ApiError(detail ?? statusMessage(response.status), response.status);
  }
  return response;
}

async function postJson<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
    signal,
  });
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError('The server sent an answer that could not be read.', response.status);
  }
}

/* ------------------------------------------------------------------ *
 * POST /explain
 * ------------------------------------------------------------------ */

export interface ExplainTab {
  tab_id: number;
  title: string;
  url: string;
  text: string;
}

export interface ExplainRequest {
  selected_text: string;
  page_text?: string;
  other_tabs?: ExplainTab[];
  question?: string | null;
}

export interface ExplainResponse {
  explanation: string;
  used_tab_ids: number[];
}

/** The backend's own limits on /explain (docs/api.md). */
export const EXPLAIN_LIMITS = {
  selectedText: 20_000,
  pageText: 1_000_000,
  otherTabs: 20,
  tabTitle: 1_000,
  tabUrl: 4_096,
  tabText: 300_000,
  question: 2_000,
} as const;

/** OpenAI calls time out at 30 s on the server; leave room for one retry. */
const EXPLAIN_TIMEOUT_MS = 70_000;

export function postExplain(request: ExplainRequest, signal?: AbortSignal): Promise<ExplainResponse> {
  return postJson<ExplainResponse>('/explain', request, EXPLAIN_TIMEOUT_MS, signal);
}

/* ------------------------------------------------------------------ *
 * POST /chat (streamed as Server-Sent Events)
 * ------------------------------------------------------------------ */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatChunk {
  id: string;
  heading: string;
  text: string;
}

export interface ChatTab {
  tab_id: number;
  title: string;
  url: string;
  chunks: ChatChunk[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  tabs: ChatTab[];
}

/** One cited chunk. `n` is its chip number. */
export interface Citation {
  n: number;
  chunk_id: string;
  tab_id: number;
  title: string;
  url: string;
  heading: string;
}

export interface ChatDone {
  answer: string;
  citations: Citation[];
  used_tab_ids: number[];
  covered: boolean;
  usage: Record<string, number>;
  timing: { first_token_ms: number | null; total_ms: number };
}

/** The backend's own limits on /chat (docs/api.md). */
export const CHAT_LIMITS = {
  messages: 50,
  messageChars: 20_000,
  tabs: 20,
  tabTitle: 1_000,
  tabUrl: 4_096,
  chunks: 1_500,
  chunkChars: 10_000,
  chunkCharsTotal: 3_000_000,
  heading: 500,
} as const;

/**
 * Stream an answer. `onToken` gets each piece of text as it arrives; the
 * promise resolves with the `done` event, or throws ApiError (an `error`
 * event, an HTTP error, a cut-off stream) or an AbortError from `signal`.
 */
export async function streamChat(
  request: ChatRequest,
  { signal, onToken }: { signal?: AbortSignal; onToken: (text: string) => void },
): Promise<ChatDone> {
  const response = await apiFetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.body) throw new ApiError('The server sent an empty answer. Try again.', response.status);
  try {
    for await (const event of readSse(response.body)) {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      if (event.event === 'token' && typeof data.text === 'string') onToken(data.text);
      else if (event.event === 'done') return data as unknown as ChatDone;
      else if (event.event === 'error') {
        throw new ApiError(typeof data.detail === 'string' ? data.detail : 'The chat service failed. Try again.', 200);
      }
    }
  } catch (error) {
    if (error instanceof ApiError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ApiError('The answer was cut off. Try again.', 0);
  }
  throw new ApiError('The answer was cut off. Try again.', 0);
}

/* ------------------------------------------------------------------ *
 * POST /rank-tabs
 * ------------------------------------------------------------------ */

export interface RankTabsRequest {
  question: string;
  tabs: { tab_id: number; title: string; url: string; snippet: string }[];
}

export interface TabScore {
  tab_id: number;
  score: number;
  suggested: boolean;
}

export async function postRankTabs(request: RankTabsRequest, signal?: AbortSignal): Promise<TabScore[]> {
  const { scores } = await postJson<{ scores: TabScore[] }>('/rank-tabs', request, 15_000, signal);
  return scores;
}

/* ------------------------------------------------------------------ *
 * POST /recap
 * ------------------------------------------------------------------ */

/** One saved note, as /recap wants it. */
export interface RecapNote {
  text: string;
  note?: string;
  question?: string;
  explanation?: string;
}

export interface RecapRequest {
  title?: string;
  url?: string;
  /** Oldest first. At least one note or chat summary is required. */
  notes?: RecapNote[];
  chat_summaries?: string[];
}

export interface RecapResponse {
  recap: string;
  points: string[];
}

/** The backend's own limits on /recap (docs/api.md). */
export const RECAP_LIMITS = {
  title: 1_000,
  url: 4_096,
  notes: 200,
  noteText: 20_000,
  note: 10_000,
  question: 2_000,
  explanation: 10_000,
  summaries: 50,
  summaryChars: 10_000,
} as const;

/** One model call, like /explain; leave room for a retry on the server. */
const RECAP_TIMEOUT_MS = 70_000;

export function postRecap(request: RecapRequest, signal?: AbortSignal): Promise<RecapResponse> {
  return postJson<RecapResponse>('/recap', request, RECAP_TIMEOUT_MS, signal);
}
