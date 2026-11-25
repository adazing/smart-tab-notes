/**
 * Chat over the current tab plus tabs the user confirms, with streamed
 * answers and numbered citation chips that switch to the cited tab.
 */

import { useEffect, useRef, useState } from 'react';
import { sendToBackground } from '../../shared/messages';
import type { TabRef } from '../../shared/types';
import { splitCitations } from '../citations';
import { useChat, type Turn } from '../useChat';
import { TabPicker, useTabPicker } from './TabPicker';

/** Bring the cited tab to the front, or reopen its page if it has closed. */
async function openSource(tabId: number, url: string): Promise<void> {
  const result = await sendToBackground('tabs:focus', { tabId });
  if (result.ok && result.data.ok) return;
  if (/^https?:\/\//.test(url)) await chrome.tabs.create({ url });
}

const STATUS_TEXT: Partial<Record<Turn['status'], string>> = {
  reading: 'Reading tabs…',
  thinking: 'Thinking…',
};

function Answer({ turn, onRetry }: { turn: Turn; onRetry?: () => void }): JSX.Element {
  const streaming = turn.status === 'streaming';
  const segments = splitCitations(turn.answer, new Set(turn.chunkTabs.keys()), turn.citations, streaming);
  // Sources: the server's list once done; before that, the chips seen so far.
  const sources = turn.citations
    ?? [...new Map(segments.flatMap((s) => (s.kind === 'cite' ? [[s.chunkId, s.n] as const] : []))).entries()]
      .map(([chunkId, n]) => {
        const tab = turn.chunkTabs.get(chunkId)!;
        return { n, chunk_id: chunkId, tab_id: tab.tabId, title: tab.title, url: tab.url, heading: '' };
      });
  const byChunk = new Map(sources.map((source) => [source.chunk_id, source]));

  return (
    <div className="answer" aria-busy={streaming || undefined}>
      {STATUS_TEXT[turn.status] && <p className="muted loading">{STATUS_TEXT[turn.status]}</p>}
      {turn.answer && (
        <p className="answer__text">
          {segments.map((segment, index) => {
            if (segment.kind === 'text') return <span key={index}>{segment.text}</span>;
            const source = byChunk.get(segment.chunkId) ?? null;
            const tab = turn.chunkTabs.get(segment.chunkId);
            const title = source?.title ?? tab?.title ?? '';
            return (
              <button
                key={index}
                type="button"
                className="chip"
                title={`Go to ${title}${source?.heading ? ` · ${source.heading}` : ''}`}
                aria-label={`Source ${segment.n}: ${title}`}
                onClick={() => void openSource(source?.tab_id ?? tab!.tabId, source?.url ?? tab!.url)}
              >
                {segment.n}
              </button>
            );
          })}
          {streaming && <span className="cursor" aria-hidden="true" />}
        </p>
      )}
      {turn.status === 'stopped' && <p className="muted">Stopped.</p>}
      {turn.status === 'error' && (
        <p className="notice" role="alert">
          {turn.error}
          {onRetry && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={onRetry}>Try again</button>
            </>
          )}
        </p>
      )}
      {turn.covered === false && (
        <p className="muted">Try ticking more tabs in the tab picker, then ask again.</p>
      )}
      {sources.length > 0 && (
        <ol className="sources" aria-label="Sources">
          {[...new Map(sources.map((s) => [s.tab_id, s])).values()].map((source) => (
            <li key={source.tab_id}>
              <button type="button" className="source" onClick={() => void openSource(source.tab_id, source.url)}>
                <span className="chip chip--static">
                  {sources.filter((s) => s.tab_id === source.tab_id).map((s) => s.n).join(', ')}
                </span>
                {source.title || source.url}
              </button>
            </li>
          ))}
        </ol>
      )}
      {turn.skipped.length > 0 && (
        <p className="muted skipped">
          Skipped: {turn.skipped.map((tab) => `${tab.title} (${tab.reason})`).join('; ')}
        </p>
      )}
    </div>
  );
}

export function ChatView({ activeTab }: { activeTab: TabRef | null }): JSX.Element {
  const [question, setQuestion] = useState('');
  const chat = useChat();
  const picker = useTabPicker(activeTab, question);
  const endRef = useRef<HTMLDivElement>(null);
  const last = chat.turns.at(-1);

  // Follow the answer as it streams, unless the user has scrolled up to read.
  useEffect(() => {
    const end = endRef.current;
    const scroller = end?.closest('.app__body');
    if (!end || !scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120 || last?.status === 'reading') {
      end.scrollIntoView({ block: 'end' });
    }
  }, [last?.answer, last?.status, chat.turns.length]);

  function submit(): void {
    const text = question.trim();
    if (!text || chat.busy || picker.chosenIds.length === 0) return;
    setQuestion('');
    void chat.send(text, picker.chosenIds);
  }

  return (
    <section className="chat">
      {chat.turns.length === 0 ? (
        <div className="chat__empty">
          <h2 className="placeholder__title">Chat</h2>
          <p className="muted">
            Ask about this tab, or tick other tabs below to compare them. Answers cite the
            tab each point came from; click a number to jump there. Tabs are only read when
            you send.
          </p>
        </div>
      ) : (
        <ol className="turns">
          {chat.turns.map((turn) => (
            <li key={turn.id} className="turn">
              <p className="turn__question">{turn.question}</p>
              <Answer
                turn={turn}
                onRetry={turn === last && !chat.busy && picker.chosenIds.length
                  ? () => void chat.send(turn.question, picker.chosenIds)
                  : undefined}
              />
            </li>
          ))}
        </ol>
      )}
      <div ref={endRef} />

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TabPicker picker={picker} disabled={chat.busy} />
        <label className="visually-hidden" htmlFor="chat-question">Question</label>
        <textarea
          id="chat-question"
          className="composer__input"
          rows={2}
          maxLength={20_000}
          placeholder={picker.chosenIds.length ? 'Ask about the selected tabs…' : 'Pick a tab to ask about…'}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer__actions">
          {chat.turns.length > 0 && !chat.busy && (
            <button type="button" className="button button--quiet" onClick={chat.clear}>New chat</button>
          )}
          {chat.busy ? (
            <button type="button" className="button" onClick={chat.stop}>Stop</button>
          ) : (
            <button type="submit" className="button" disabled={!question.trim() || picker.chosenIds.length === 0}>
              Send
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
