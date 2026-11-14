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
import { isNoReceiverError, sendToTab } from '../../shared/messages';
import type { PageState } from '../usePageState';

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
