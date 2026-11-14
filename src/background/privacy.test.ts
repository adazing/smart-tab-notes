import { beforeEach, expect, it, vi } from 'vitest';
import type { MessageHandler } from '../shared/messages';
import { getPrivacySettings, PRIVACY_KEY } from '../shared/privacy';
const { handlers } = vi.hoisted(() => ({ handlers: {} as Record<string, unknown> }));
vi.mock('../shared/messages', () => ({
  registerHandlers: (_: string, registered: Record<string, unknown>) => Object.assign(handlers, registered),
  notify: vi.fn(async () => {}), sendToTab: vi.fn(async () => ({})),
}));
let stored: Record<string, unknown>;
const event = { addListener: vi.fn(), removeListener: vi.fn() };
beforeEach(async () => {
  stored = {};
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: vi.fn(async () => structuredClone(stored)),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(stored, structuredClone(value)); }),
    }, onChanged: event },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { onInstalled: event, getURL: (path: string) => `chrome-extension://test/${path}` },
    tabs: { onActivated: event, onUpdated: event }, windows: { onFocusChanged: event },
  });
  vi.resetModules();
  await import('./index');
});
async function update(action: 'add' | 'remove' | 'complete', domain?: string): Promise<unknown> {
  return (handlers['privacy:update'] as MessageHandler<'privacy:update'>)({ action, domain }, { url: 'chrome-extension://test/sidepanel.html' });
}
it('persists normalized additions and removals without restoring defaults across reloads', async () => {
  await update('add', 'https://WWW.Example.com/path');
  expect((await getPrivacySettings()).blockedDomains).toContain('example.com');
  await expect(update('add', 'EXAMPLE.COM')).rejects.toThrow('already blocked');
  await update('remove', 'chase.com');
  vi.resetModules();
  const fresh = await import('../shared/privacy');
  expect((await fresh.getPrivacySettings()).blockedDomains).not.toContain('chase.com');
  await update('complete');
  expect((await getPrivacySettings()).onboardingComplete).toBe(true);
});
it('serializes concurrent writes and never reports successful failed persistence', async () => {
  await Promise.all([update('add', 'one.example'), update('add', 'two.example')]);
  expect((await getPrivacySettings()).blockedDomains).toEqual(expect.arrayContaining(['one.example', 'two.example']));
  vi.mocked(chrome.storage.local.set).mockImplementationOnce(async () => { throw new Error('Disk full'); });
  await expect(update('remove', 'chase.com')).rejects.toThrow('Disk full');
  expect((stored[PRIVACY_KEY] as { blockedDomains: string[] }).blockedDomains).toContain('chase.com');
});
it('rejects content-script preference changes and selected text from blocked origins', async () => {
  await expect((handlers['privacy:update'] as MessageHandler<'privacy:update'>)({ action: 'complete' }, { tab: { id: 1 } as chrome.tabs.Tab })).rejects.toThrow('side panel');
  await update('complete');
  const response = await (handlers['toolbar:action'] as MessageHandler<'toolbar:action'>)(
    { action: 'explain', text: 'secret', url: 'https://example.com' },
    { tab: { url: 'https://chase.com' } as chrome.tabs.Tab },
  );
  expect(response.ok).toBe(false);
});
