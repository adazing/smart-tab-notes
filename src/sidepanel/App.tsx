/**
 * Side panel shell.
 *
 * Owns the three views and the navigation between them.
 */

import { useEffect, useRef, useState } from 'react';
import { onMessage } from '../shared/messages';
import { FOCUSED_NOTE_KEY, SIDE_PANEL_VIEWS, SIDE_PANEL_VIEW_LABELS } from '../shared/types';
import type { SidePanelView } from '../shared/types';
import { usePageState } from './usePageState';
import { ChatView } from './views/ChatView';
import { ThisPageView } from './views/ThisPageView';
import { LibraryView } from './views/LibraryView';

export function App(): JSX.Element {
  const [view, setView] = useState<SidePanelView>('chat');
  const page = usePageState();
  /** The note the user just clicked on the page; `at` makes each click a new request. */
  const [focus, setFocus] = useState<{ id: string; at: number } | null>(null);
  const windowRef = useRef<number | null>(null);
  windowRef.current = page.activeTab?.windowId ?? null;

  // Anything in the extension can bring a view to the front, e.g. the
  // highlight popup opening the panel on "This page".
  useEffect(() => {
    return onMessage('sidepanel', 'sidepanel:navigate', ({ view: next }) => {
      setView(next);
      return { ok: true };
    });
  }, []);

  // Clicking a note's text on the page brings it up here.
  useEffect(() => {
    return onMessage('sidepanel', 'annotations:focused', ({ id, windowId }) => {
      if (windowRef.current !== null && windowId !== windowRef.current) return { ok: true };
      setView('page');
      setFocus({ id, at: Date.now() });
      return { ok: true };
    });
  }, []);

  // A panel opened by that click mounts after the message went out; the
  // worker left the note in session storage for it.
  const windowId = page.activeTab?.windowId;
  useEffect(() => {
    if (windowId === undefined) return;
    void chrome.storage.session.get(FOCUSED_NOTE_KEY).then((stored) => {
      const note = stored[FOCUSED_NOTE_KEY] as { id: string; windowId: number; at: number } | undefined;
      if (note && note.windowId === windowId && Date.now() - note.at < 5_000) {
        setView('page');
        setFocus({ id: note.id, at: Date.now() });
      }
    }).catch(() => {});
  }, [windowId]);

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
        {/* Always mounted, so the conversation survives switching views. */}
        <div hidden={view !== 'chat'}>
          <ChatView activeTab={page.activeTab} />
        </div>
        {view === 'page' && <ThisPageView page={page} focus={focus} />}
        {view === 'library' && <LibraryView />}
      </main>
    </div>
  );
}
