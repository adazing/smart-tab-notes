import { beforeEach, expect, it, vi } from 'vitest';
import { canReadUrl, DEFAULT_BLOCKED_DOMAINS, getPrivacySettings, isBlockedUrl, matchesBlockedUrl, normalizeDomain, PRIVACY_KEY } from './privacy';
let stored: Record<string, unknown>;
beforeEach(() => {
  stored = {};
  vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => stored) } } });
});
it('provides starter defaults and gates onboarding without overwriting storage', async () => {
  expect((await getPrivacySettings()).blockedDomains).toEqual(DEFAULT_BLOCKED_DOMAINS);
  for (const domain of DEFAULT_BLOCKED_DOMAINS) expect(await isBlockedUrl(`https://${domain}`)).toBe(true);
  expect(await canReadUrl('https://example.com')).toBe(false);
  stored[PRIVACY_KEY] = { blockedDomains: [], onboardingComplete: true };
  expect(await isBlockedUrl('https://chase.com')).toBe(false);
  expect(await canReadUrl('https://example.com')).toBe(true);
  expect((await getPrivacySettings()).blockedDomains).toEqual([]);
});
it.each(['https://CHASE.COM:8080/path?q=1#x', 'https://secure.chase.com/login', 'https://www.chase.com', 'https://chase.com./'])('matches hostname boundaries: %s', url => {
  expect(matchesBlockedUrl(url, ['chase.com'])).toBe(true);
});
it.each(['https://notchase.com', 'https://chase.com.evil.org', 'https://example.org/?chase.com'])('allows lookalikes: %s', url => {
  expect(matchesBlockedUrl(url, ['chase.com'])).toBe(false);
});
it('normalizes domains and full URLs', () => {
  expect(normalizeDomain(' WWW.Example.COM ')).toBe('example.com');
  expect(normalizeDomain('https://EXAMPLE.com:8080/path?q=1#x')).toBe('example.com');
});
it.each(['', 'bad domain', 'https://', 'file:///tmp/a', 'https://user:pass@example.com', '-bad.com', 'example..com', '*.example.com'])('rejects invalid domain: %s', value => {
  expect(() => normalizeDomain(value)).toThrow();
});
it('fails closed on malformed URLs, corrupt settings and storage failures', async () => {
  expect(matchesBlockedUrl('not a url', [])).toBe(true);
  expect(matchesBlockedUrl('chrome://settings', [])).toBe(true);
  stored[PRIVACY_KEY] = { blockedDomains: ['invalid domain'], onboardingComplete: true };
  expect(await canReadUrl('https://example.com')).toBe(false);
  vi.mocked(chrome.storage.local.get).mockRejectedValue(new Error('unavailable'));
  expect(await isBlockedUrl('https://example.com')).toBe(true);
});
