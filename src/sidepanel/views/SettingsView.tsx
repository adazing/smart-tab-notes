import { useState } from 'react';
import { sendToBackground, notify } from '../../shared/messages';
import { clearAllData, clearPageNotes, normalizeUrl } from '../../shared/storage';
import { getActiveTabRef } from '../../shared/tabs';
import type { PrivacySettings } from '../../shared/privacy';

type Confirmation = { kind: 'page'; url: string } | { kind: 'all' };
export function SettingsView({ settings, onPrivacy }: { settings: PrivacySettings; onPrivacy: () => void }): JSX.Element {
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  async function run(operation: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true); setError(''); setStatus('');
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Operation failed. Please try again.'); }
    finally { setBusy(false); }
  }
  async function update(action: 'add' | 'remove', value: string): Promise<void> {
    const result = await sendToBackground('privacy:update', { action, domain: value });
    if (!result.ok) throw new Error(action === 'add' ? 'Could not add domain. Check for invalid or duplicate domains and try again.' : 'Could not remove domain. Please try again.');
    if (action === 'add') setDomain('');
    setStatus('Blocked sites saved.');
  }
  async function confirmPage(): Promise<void> {
    const window = await chrome.windows.getCurrent();
    const tab = await getActiveTabRef(window.id);
    if (!tab) throw new Error('No active page is available.');
    setConfirmation({ kind: 'page', url: normalizeUrl(tab.url) });
  }
  async function remove(): Promise<void> {
    if (!confirmation) return;
    if (confirmation.kind === 'page') {
      const count = await clearPageNotes(confirmation.url);
      setStatus(count ? 'Page notes and highlights removed.' : 'This page has no saved notes or highlights.');
    } else { await clearAllData(); setStatus('All saved data removed. Privacy preferences are preserved.'); }
    setConfirmation(null);
    await notify('background', 'data:cleared', confirmation.kind === 'page' ? { url: confirmation.url } : {});
  }
  return <section className="page">
    <h2 className="page__title">Settings</h2>
    <fieldset disabled={busy}>
      <div className="card"><h3>Blocked Sites</h3>
        <p className="muted">Blocked websites and their subdomains cannot be read or included in tab context.</p>
        <form onSubmit={event => { event.preventDefault(); void run(() => update('add', domain)); }}>
          <label htmlFor="blocked-domain">Website domain or URL</label>
          <div className="settings-row"><input id="blocked-domain" value={domain} onChange={event => setDomain(event.target.value)} placeholder="example.com" required />
            <button className="button" type="submit">Add</button></div>
        </form>
        {settings.blockedDomains.length ? <ul className="domain-list">{settings.blockedDomains.map(value =>
          <li key={value}><span>{value}</span><button className="button" aria-label={`Remove ${value}`} onClick={() => void run(() => update('remove', value))}>Remove</button></li>)}</ul>
          : <p className="muted">No websites are blocked.</p>}
      </div>
      <div className="card"><h3>Data Management</h3>
        <p className="muted">Permanently delete saved content. Blocklist preferences and onboarding status are preserved.</p>
        <div className="settings-actions">
          <button className="button" onClick={() => void run(confirmPage)}>Clear This Page's Notes</button>
          <button className="button danger" onClick={() => { setError(''); setStatus(''); setConfirmation({ kind: 'all' }); }}>Clear All Data</button>
        </div>
      </div>
      {confirmation && <div className="card" role="alertdialog" aria-modal="false" aria-labelledby="delete-title" aria-describedby="delete-description">
        <h3 id="delete-title">{confirmation.kind === 'page' ? 'Clear notes for this page?' : 'Clear all saved data?'}</h3>
        <p id="delete-description">{confirmation.kind === 'page'
          ? 'This will remove all saved notes and highlights associated with the current page.'
          : 'This will permanently remove your saved pages, notes, highlights, chat summaries, and collections. This action cannot be undone.'}</p>
        {confirmation.kind === 'page' && <p className="page__url">{confirmation.url}</p>}
        <div className="settings-row"><button autoFocus className="button" onClick={() => setConfirmation(null)}>Cancel</button>
          <button className="button danger" onClick={() => void run(remove)}>{confirmation.kind === 'page' ? 'Clear Notes' : 'Clear All Data'}</button></div>
      </div>}
      <button className="button" onClick={onPrivacy}>Privacy information</button>
    </fieldset>
    {busy && <p role="status">Working…</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
  </section>;
}
