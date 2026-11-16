import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CHAT_LIMITS, streamChat } from '../shared/api';
import type { TabContext } from '../shared/types';
import { HISTORY_TURNS, toChatMessages, toChatTabs, urlForRanking } from './chatRequest';

const context = (tabId: number, chunks: string[], status: TabContext['status'] = 'ok'): TabContext => ({
  tabId, title: `Tab ${tabId}`, url: `https://s${tabId}.example/`, groupId: -1, loaded: true, status,
  text: chunks.join('\n'), wordCount: 0, extractor: 'readability', truncated: false,
  chunks: chunks.map((text, index) => ({ id: `t${tabId}-c${index}`, index, heading: 'H', text, tokenEstimate: 1 })),
});

describe('toChatTabs', () => {
  it('keeps readable tabs and says why the others were skipped', () => {
    const { tabs, skipped } = toChatTabs([context(1, ['a', 'b']), context(2, [], 'not_loaded'), context(3, [], 'ok')]);
    expect(tabs).toEqual([{
      tab_id: 1, title: 'Tab 1', url: 'https://s1.example/',
      chunks: [{ id: 't1-c0', heading: 'H', text: 'a' }, { id: 't1-c1', heading: 'H', text: 'b' }],
    }]);
    expect(skipped.map((s) => [s.tabId, s.reason])).toEqual([
      [2, 'not loaded yet (visit it once, then ask again)'], [3, 'no readable text'],
    ]);
  });

  it('stops adding chunks at the total size limit', () => {
    const big = 'x'.repeat(CHAT_LIMITS.chunkChars);
    const perTab = Array.from({ length: 200 }, () => big);
    const { tabs, skipped } = toChatTabs([context(1, perTab), context(2, perTab)]);
    const total = tabs.flatMap((t) => t.chunks).reduce((sum, c) => sum + c.text.length, 0);
    expect(total).toBeLessThanOrEqual(CHAT_LIMITS.chunkCharsTotal);
    expect(tabs).toHaveLength(2);
    expect(skipped).toEqual([]);
  });
});

describe('toChatMessages', () => {
  it('sends the last answered exchanges then the question', () => {
    const history = Array.from({ length: HISTORY_TURNS + 2 }, (_, i) => ({ question: `q${i}`, answer: i === 1 ? '' : `a${i}` }));
    const messages = toChatMessages(history, 'now');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'now' });
    expect(messages).toHaveLength(HISTORY_TURNS * 2 + 1);
    expect(messages[0]).toEqual({ role: 'user', content: 'q2' });
  });
});

it('ranks tabs on origin and path only', () => {
  expect(urlForRanking('https://mail.example/inbox?token=secret#msg')).toBe('https://mail.example/inbox');
  expect(urlForRanking('not a url')).toBe('');
});

describe('streamChat', () => {
  afterEach(() => vi.unstubAllGlobals());

  function serve(body: string, status = 200): void {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          // Split mid-event to exercise the parser across chunks.
          const bytes = new TextEncoder().encode(body);
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        },
      }),
      { status, headers: { 'Content-Type': 'text/event-stream' } },
    )));
  }

  const request = { messages: [{ role: 'user' as const, content: 'q' }], tabs: [] };

  it('passes tokens through and resolves with done', async () => {
    serve('event: token\ndata: {"text": "Hi "}\n\nevent: token\ndata: {"text": "[t1-c0]"}\n\nevent: done\ndata: {"answer": "Hi [t1-c0]", "citations": [], "used_tab_ids": [1], "covered": true}\n\n');
    const tokens: string[] = [];
    const done = await streamChat(request, { onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(['Hi ', '[t1-c0]']);
    expect(done).toMatchObject({ answer: 'Hi [t1-c0]', covered: true });
  });

  it('throws the detail of an error event, even as the first event', async () => {
    serve('event: error\ndata: {"detail": "The chat service failed. Try again."}\n\n');
    await expect(streamChat(request, { onToken: () => {} })).rejects.toThrow('The chat service failed. Try again.');
  });

  it('throws when the stream ends without done', async () => {
    serve('event: token\ndata: {"text": "Hi"}\n\n');
    await expect(streamChat(request, { onToken: () => {} })).rejects.toBeInstanceOf(ApiError);
  });

  it('reports a 503 detail before streaming', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'OPENAI_API_KEY is not set.' }), { status: 503 })));
    await expect(streamChat(request, { onToken: () => {} })).rejects.toThrow('OPENAI_API_KEY is not set.');
  });
});
