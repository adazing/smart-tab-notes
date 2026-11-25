/**
 * "Notes" view: the notes saved on the page in view. Every note is a
 * highlight on the page, possibly with no text yet.
 *
 * Clicking a note here jumps to its highlight on the page, and clicking
 * highlighted text on the page brings its note up here (`focus`). The week 1
 * debugging cards (selection, extracted text, connection check) live in a
 * collapsed "Developer tools" section at the bottom.
 */

import { useEffect, useRef, useState } from 'react';
import { isNoReceiverError, sendToBackground, sendToTab } from '../../shared/messages';
import type { Annotation } from '../../shared/storage-types';
import type { TabContext } from '../../shared/types';
import type { PageState } from '../usePageState';
import { useAnnotations } from '../useAnnotations';

const EXTRACTOR_LABELS: Record<NonNullable<TabContext['extractor']>, string> = {
  'stack-exchange': 'Stack Exchange rule',
  readability: 'Readability',
  'visible-text': 'visible-text fallback',
};

const STATUS_LABELS: Record<TabContext['status'], string> = {
  ok: 'Extracted',
  not_loaded: 'Tab not loaded yet. Visit it, then try again.',
  restricted: 'Chrome does not let extensions read this page.',
  pdf: 'PDFs are not supported yet.',
  error: 'Could not read this page.',
};

/**
 * Developer card: runs getTabContext on the tab in view so extraction can be
 * checked (and demoed) per site. Reading only happens on the button click.
 */
function PageTextCard({ tabId }: { tabId: number }): JSX.Element {
  const [context, setContext] = useState<TabContext | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  async function extract(): Promise<void> {
    setState('loading');
    const result = await sendToBackground('tabs:getContext', { tabIds: [tabId] });
    if (result.ok && result.data.contexts[0]) {
      setContext(result.data.contexts[0]);
      setState('idle');
    } else {
      setError(result.ok ? 'No result' : result.error);
      setState('error');
    }
  }

  const shown = context?.tabId === tabId ? context : null;

  return (
    <div className="card">
      <h3 className="card__title">Page text</h3>
      <button type="button" className="button" onClick={() => void extract()} disabled={state === 'loading'}>
        {state === 'loading' ? 'Reading...' : 'Extract text'}
      </button>
      {state === 'error' && <p className="notice">{error}</p>}
      {shown && (
        <>
          <p className="muted">
            {STATUS_LABELS[shown.status]}
            {shown.error ? ` (${shown.error})` : ''}
          </p>
          {shown.status === 'ok' && (
            <>
              <p className="muted">
                {shown.wordCount.toLocaleString()} words · {shown.chunks.length} chunks ·{' '}
                {EXTRACTOR_LABELS[shown.extractor ?? 'visible-text']}
                {shown.truncated ? ' · truncated' : ''}
              </p>
              <ol className="muted">
                {shown.chunks.slice(0, 5).map((chunk) => (
                  <li key={chunk.id}>
                    <strong>{chunk.heading || '(no heading)'}</strong> · ~{chunk.tokenEstimate} tokens
                    <br />
                    {chunk.text.slice(0, 160)}
                    {chunk.text.length > 160 ? '…' : ''}
                  </li>
                ))}
              </ol>
              {shown.chunks.length > 5 && <p className="muted">…and {shown.chunks.length - 5} more</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Jump to a note's highlight on the page: scroll, flash and open its card. */
async function revealNote(tabId: number, id: string): Promise<string | null> {
  const result = await sendToTab(tabId, 'annotations:reveal', { id });
  if (result.ok && result.data.ok) return null;
  if (!result.ok && isNoReceiverError(result.error)) return 'Reload the page to show its highlights.';
  return result.ok ? result.data.reason ?? 'This highlight is not on the page right now.' : result.error;
}

/**
 * Every highlight saved on this page, oldest first. Clicking one jumps to it
 * on the page. A note whose text the page no longer contains is marked
 * rather than lost: the highlight is gone from the page, not from the user.
 */
function NotesCard({ url, tabId, focus }: { url: string | null; tabId: number; focus: NoteFocus }): JSX.Element {
  const { annotations, loading, error, reload } = useAnnotations(url);
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The note being edited, and the text in its box. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const orphaned = annotations.filter((note) => note.orphaned === true).length;
  /** The note the user just clicked on the page, flashed for a moment. */
  const [flashing, setFlashing] = useState<string | null>(null);
  const handled = useRef<number | null>(null);

  // Scroll to the clicked note once it is in the list (a new note may still
  // be loading), once per click.
  useEffect(() => {
    if (!focus || handled.current === focus.at) return;
    const element = document.querySelector(`[data-note-id="${CSS.escape(focus.id)}"]`);
    if (!element) return;
    handled.current = focus.at;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashing(focus.id);
    window.setTimeout(() => setFlashing((current) => (current === focus.id ? null : current)), 1_800);
  }, [focus, annotations]);

  async function jump(note: Annotation): Promise<void> {
    setMessage(null);
    const problem = await revealNote(tabId, note.id);
    if (problem) setMessage({ id: note.id, text: problem });
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return;
    setSaving(true);
    // Through the worker, so the card on the page shows the new text too.
    const result = await sendToBackground('annotations:update', { id: editing.id, note: editing.text.trim() });
    setSaving(false);
    if (!result.ok || !result.data.ok) {
      setMessage({ id: editing.id, text: result.ok ? result.data.reason ?? 'Could not save.' : result.error });
      return;
    }
    setEditing(null);
    reload();
  }

  async function remove(note: Annotation): Promise<void> {
    if (confirming !== note.id) {
      setConfirming(note.id);
      return;
    }
    setConfirming(null);
    // Through the worker, so the page's highlight goes away too.
    const result = await sendToBackground('annotations:delete', { id: note.id });
    if (!result.ok || !result.data.ok) {
      setMessage({ id: note.id, text: result.ok ? result.data.reason ?? 'Could not delete.' : result.error });
    }
    reload();
  }

  return (
    <div className="card">
      <h3 className="card__title">
        Notes on this page{annotations.length ? ` (${annotations.length})` : ''}
      </h3>
      {error && (
        <p className="notice">
          {error}{' '}
          <button type="button" className="link-button" onClick={reload}>Try again</button>
        </p>
      )}
      {!error && loading && annotations.length === 0 && <p className="muted">Loading...</p>}
      {!error && !loading && annotations.length === 0 && (
        <p className="muted">No notes on this page yet.</p>
      )}
      {orphaned > 0 && (
        <p className="muted">{orphaned} not found on the page right now.</p>
      )}
      {annotations.length > 0 && (
        <ol className="notes">
          {annotations.map((note) => (
            <li
              key={note.id}
              data-note-id={note.id}
              className={'note' + (note.orphaned ? ' note--orphaned' : '') + (flashing === note.id ? ' note--focused' : '')}
            >
              <button
                type="button"
                className="note__jump"
                title={note.orphaned ? 'Not found on the page right now' : 'Show on the page'}
                onClick={() => void jump(note)}
              >
                <blockquote className="quote">{note.text}</blockquote>
              </button>
              {editing?.id === note.id ? (
                <form
                  className="note__edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit();
                  }}
                >
                  <textarea
                    aria-label="Note"
                    placeholder="Add a note"
                    value={editing.text}
                    autoFocus
                    onChange={(event) => setEditing({ id: note.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditing(null);
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void saveEdit();
                    }}
                  />
                  <div className="note__edit-actions">
                    <button type="submit" className="button" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                    <button type="button" className="button button--quiet" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                note.note && <p className="note__mine">{note.note}</p>
              )}
              {note.question && <p className="note__question">Q: {note.question}</p>}
              {note.explanation && <p className="note__explanation">{note.explanation}</p>}
              {note.sources && note.sources.length > 0 && (
                <p className="note__sources">
                  From:{' '}
                  {note.sources.map((source, index) => (
                    <span key={source.url + index}>
                      {index > 0 && ' · '}
                      <a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a>
                    </span>
                  ))}
                </p>
              )}
              {note.orphaned && <p className="note__flag">Not found on the page right now.</p>}
              {message?.id === note.id && <p className="note__flag">{message.text}</p>}
              <p className="note__meta">
                {new Date(note.createdAt).toLocaleString()}
                {' · '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => { setMessage(null); setEditing({ id: note.id, text: note.note ?? '' }); }}
                >
                  {note.note ? 'Edit note' : 'Write note'}
                </button>
                {' · '}
                <button type="button" className="link-button" onClick={() => void remove(note)}>
                  {confirming === note.id ? 'Really delete?' : 'Delete'}
                </button>
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Tools for checking the week 1 plumbing. Collapsed: users don't need them. */
function DeveloperTools({ page }: { page: PageState }): JSX.Element {
  const { activeTab, selection } = page;
  const [check, setCheck] = useState<string | null>(null);

  async function runConnectionCheck(): Promise<void> {
    if (!activeTab) return;
    setCheck('Checking...');
    const result = await sendToTab(activeTab.tabId, 'ping', { from: 'sidepanel' });
    if (result.ok) {
      setCheck('Content script replied at ' + new Date(result.data.at).toLocaleTimeString());
    } else if (isNoReceiverError(result.error)) {
      setCheck('No content script on this page. Reload the tab after building.');
    } else {
      setCheck(result.error);
    }
  }

  if (!activeTab) return <></>;
  return (
    <details className="devtools">
      <summary className="muted">Developer tools</summary>
      <p className="muted devtools__url">{activeTab.url}</p>

      <div className="card">
        <h3 className="card__title">Current selection</h3>
        {selection ? (
          <blockquote className="quote">{selection.text}</blockquote>
        ) : (
          <p className="muted">Select text on the page to see what the extension receives.</p>
        )}
      </div>

      <PageTextCard tabId={activeTab.tabId} />

      <div className="card">
        <h3 className="card__title">Connection check</h3>
        <button
          type="button"
          className="button"
          onClick={() => void runConnectionCheck()}
          disabled={!activeTab.accessible}
        >
          Ping this page
        </button>
        {check && <p className="muted">{check}</p>}
      </div>
    </details>
  );
}

/** A note to bring into view; `at` makes each request new. */
export type NoteFocus = { id: string; at: number } | null;

interface ThisPageViewProps {
  page: PageState;
  focus?: NoteFocus;
}

export function ThisPageView({ page, focus = null }: ThisPageViewProps): JSX.Element {
  const { activeTab, loading, refresh } = page;

  if (loading && !activeTab) {
    return <section className="page"><p className="muted">Loading...</p></section>;
  }

  if (!activeTab) {
    return (
      <section className="page">
        <p className="muted">No active tab.</p>
        <button type="button" className="button" onClick={refresh}>
          Try again
        </button>
      </section>
    );
  }

  return (
    <section className="page">
      <h2 className="page__title">{activeTab.title || 'Untitled page'}</h2>

      {activeTab.accessible ? (
        <NotesCard url={activeTab.url} tabId={activeTab.tabId} focus={focus} />
      ) : (
        <p className="notice">
          The browser doesn't let extensions work on this page (browser settings, new tab
          pages, add-on stores), so there are no highlights here. Open a normal website.
        </p>
      )}

      <DeveloperTools page={page} />
    </section>
  );
}
