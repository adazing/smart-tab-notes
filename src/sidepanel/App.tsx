/**
 * Side panel shell.
 *
 * Owns the three views and the navigation between them. The views
 * themselves are empty placeholders for now -- each is a separate ticket.
 */

import { useEffect, useState } from 'react';
import { onMessage } from '../shared/messages';
import { SIDE_PANEL_VIEWS, SIDE_PANEL_VIEW_LABELS } from '../shared/types';
import type { SidePanelView } from '../shared/types';
import { usePageState } from './usePageState';
import { ChatView } from './views/ChatView';
import { ThisPageView } from './views/ThisPageView';
import { LibraryView } from './views/LibraryView';

export function App(): JSX.Element {
  const [view, setView] = useState<SidePanelView>('chat');
  const page = usePageState();

  // Anything in the extension can bring a view to the front, e.g. the
  // highlight popup opening the panel on "This page".
  useEffect(() => {
    return onMessage('sidepanel', 'sidepanel:navigate', ({ view: next }) => {
      setView(next);
      return { ok: true };
    });
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Smart Tab Notes</h1>
        <nav className="nav" aria-label="Side panel sections">
          {SIDE_PANEL_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className="nav__item"
              aria-current={view === candidate ? 'page' : undefined}
              onClick={() => setView(candidate)}
            >
              {SIDE_PANEL_VIEW_LABELS[candidate]}
            </button>
          ))}
        </nav>
      </header>

      <main className="app__body">
        {view === 'chat' && <ChatView />}
        {view === 'page' && <ThisPageView page={page} />}
        {view === 'library' && <LibraryView />}
      </main>
    </div>
  );
}
