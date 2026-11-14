import { getPrivacySettings, subscribePrivacy, type PrivacySettings } from '../shared/privacy';
import { sendToBackground } from '../shared/messages';
import { PrivacyView } from './views/PrivacyView';
import { SettingsView } from './views/SettingsView';
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
  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [privacy, setPrivacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const load = (): void => {
      setRevision(value => value + 1);
      void getPrivacySettings().then(setSettings).catch(() => setError('Could not load privacy settings. Reopen the panel to retry. Reading is disabled.'));
    };
    load();
    return subscribePrivacy(load);
  }, []);
  useEffect(() => onMessage('sidepanel', 'data:cleared', () => {
    setRevision(value => value + 1); page.refresh(); return { ok: true };
  }), [page.refresh]);
  async function continuePrivacy(): Promise<void> {
    if (settings?.onboardingComplete) { setPrivacy(false); return; }
    setBusy(true); setError('');
    const result = await sendToBackground('privacy:update', { action: 'complete' });
    if (result.ok) { setSettings(result.data); setPrivacy(false); }
    else setError('Could not save your choice. Please try again.');
    setBusy(false);
  }

  // Anything in the extension can bring a view to the front, e.g. the
  // highlight popup opening the panel on "This page".
  useEffect(() => {
    return onMessage('sidepanel', 'sidepanel:navigate', ({ view: next }) => {
      setView(next);
      return { ok: true };
    });
  }, []);

  if (!settings) return <main className="app__body"><p role={error ? 'alert' : 'status'}>{error || 'Loading privacy settings…'}</p></main>;
  if (!settings.onboardingComplete || privacy) return <main className="app__body"><PrivacyView onContinue={() => void continuePrivacy()} busy={busy} error={error} /></main>;

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
        {view === 'settings' && <SettingsView settings={settings} onPrivacy={() => setPrivacy(true)} />}
        {view === 'chat' && <ChatView />}
        {view === 'page' && <ThisPageView key={revision} page={page} />}
        {view === 'library' && <LibraryView />}
      </main>
    </div>
  );
}
