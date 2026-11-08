/**
 * "This page" view.
 *
 * The annotations and the revisit recap are separate tickets. For now this
 * view doubles as the scaffold's proof that the message bus works in all
 * three directions:
 *
 *   side panel -> background    the active tab, below
 *   content -> background -> side panel    the live selection
 *   side panel -> content       the connection check button
 */

import { useState } from 'react';
import { isNoReceiverError, sendToBackground, sendToTab } from '../../shared/messages';
import type { TabContext } from '../../shared/types';
import type { PageState } from '../usePageState';

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

interface ThisPageViewProps {
  page: PageState;
}

export function ThisPageView({ page }: ThisPageViewProps): JSX.Element {
  const { activeTab, selection, loading, refresh } = page;
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

  if (loading) {
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
      <p className="page__url">{activeTab.url}</p>

      {!activeTab.accessible && (
        <p className="notice">
          Extensions cannot read this page, so notes and highlights are
          unavailable here.
        </p>
      )}

      <div className="card">
        <h3 className="card__title">Current selection</h3>
        {selection ? (
          <blockquote className="quote">{selection.text}</blockquote>
        ) : (
          <p className="muted">Highlight text on the page to see it here.</p>
        )}
      </div>

      <div className="card">
        <h3 className="card__title">Notes</h3>
        <p className="muted">
          Saved annotations and the revisit recap will appear here.
        </p>
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
    </section>
  );
}
