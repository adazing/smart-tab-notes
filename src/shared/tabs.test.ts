import { expect, it, vi } from 'vitest';
import { listTabs, listTabGroups } from './tabs';
it('filters blocked tabs and group members from the shared picker integration point on every query', async () => {
  let blockedDomains = ['chase.com'];
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({ privacySettings: { blockedDomains, onboardingComplete: true } }) } },
    tabs: { query: async () => [
      { id: 1, windowId: 1, groupId: 2, url: 'https://secure.chase.com' },
      { id: 2, windowId: 1, groupId: 2, url: 'https://example.com' },
    ] },
    tabGroups: { query: async () => [{ id: 2, windowId: 1, title: 'Group' }] },
  });
  const tabs = await listTabs();
  expect(tabs.map(tab => tab.tabId)).toEqual([2]);
  expect((await listTabGroups(tabs))[0]?.tabIds).toEqual([2]);
  blockedDomains = ['example.com', 'chase.com'];
  expect(await listTabs()).toEqual([]);
});
