// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SettingsView } from './views/SettingsView';
import { App } from './App';
import { getActiveTabRef } from '../shared/tabs';
import { clearAllData, clearPageNotes } from '../shared/storage';
import { getPrivacySettings } from '../shared/privacy';
import { sendToBackground } from '../shared/messages';
vi.mock('../shared/storage', () => ({ clearAllData: vi.fn(async () => {}), clearPageNotes: vi.fn(async () => 2), normalizeUrl: (url: string) => url }));
vi.mock('../shared/tabs', () => ({ getActiveTabRef: vi.fn(async () => ({ url: 'https://example.com' })) }));
vi.mock('../shared/privacy', () => ({ getPrivacySettings: vi.fn(), subscribePrivacy: () => () => {} }));
vi.mock('../shared/messages', () => ({ onMessage: () => () => {}, notify: vi.fn(async () => {}), sendToBackground: vi.fn() }));
vi.mock('./usePageState', () => ({ usePageState: () => ({ activeTab: null, selection: null, loading: false, refresh: () => {} }) }));
let container: HTMLDivElement;
let root: Root;
const settings = { blockedDomains: ['chase.com'], onboardingComplete: true };
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => { button.click(); });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', { windows: { getCurrent: async () => ({ id: 42 }) } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(getPrivacySettings).mockResolvedValue(settings);
  vi.mocked(sendToBackground).mockResolvedValue({ ok: true, data: settings });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function renderSettings(): Promise<void> {
  await act(async () => root.render(createElement(SettingsView, { settings, onPrivacy: vi.fn() })));
}
it('requires confirmation and cancel preserves data; confirms only the captured page', async () => {
  await renderSettings();
  await click("Clear This Page's Notes");
  expect(clearPageNotes).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Clear notes for this page?');
  await click('Cancel');
  expect(clearPageNotes).not.toHaveBeenCalled();
  await click("Clear This Page's Notes"); await click('Clear Notes');
  expect(clearPageNotes).toHaveBeenCalledWith('https://example.com');
  expect(getActiveTabRef).toHaveBeenCalledWith(42);
  expect(container.textContent).toContain('Page notes and highlights removed.');
});
it('confirms all-data deletion and displays failures without false success', async () => {
  await renderSettings(); await click('Clear All Data');
  expect(clearAllData).not.toHaveBeenCalled();
  await click('Cancel'); expect(clearAllData).not.toHaveBeenCalled();
  vi.mocked(clearAllData).mockRejectedValueOnce(new Error('Database unavailable'));
  await click('Clear All Data');
  await act(async () => container.querySelector<HTMLButtonElement>('[role="alertdialog"] .danger')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Database unavailable');
  expect(container.textContent).not.toContain('All saved data removed.');
  await act(async () => container.querySelector<HTMLButtonElement>('[role="alertdialog"] .danger')!.click());
  expect(container.textContent).toContain('All saved data removed.');
});
it('shows first-run onboarding and persists completion before opening navigation', async () => {
  vi.mocked(getPrivacySettings).mockResolvedValue({ ...settings, onboardingComplete: false });
  await act(async () => root.render(createElement(App)));
  expect(container.textContent).toContain('Your privacy controls');
  expect(container.querySelector('nav')).toBeNull();
  await click('Continue');
  expect(sendToBackground).toHaveBeenCalledWith('privacy:update', { action: 'complete' });
  expect(container.querySelector('nav')).not.toBeNull();
});
it('returning users skip onboarding and can reopen privacy from Settings', async () => {
  await act(async () => root.render(createElement(App)));
  expect(container.querySelector('nav')).not.toBeNull();
  await click('Settings'); await click('Privacy information');
  expect(container.textContent).toContain('Your privacy controls');
  await click('Continue'); expect(container.textContent).toContain('Blocked Sites');
});
