/** One persisted source of truth. Mutations are serialized by the background worker. */
export const PRIVACY_KEY = 'privacySettings';
export const DEFAULT_BLOCKED_DOMAINS = [
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'capitalone.com', 'citi.com',
];
export interface PrivacySettings { blockedDomains: string[]; onboardingComplete: boolean }
export function normalizeDomain(input: string): string {
  const value = input.trim();
  if (!value || /\s/.test(value)) throw new Error('Enter a valid website domain or HTTP(S) URL.');
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    host.length > 253 || !host.includes('.') || !host.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Enter a valid website domain or HTTP(S) URL.');
  }
  return host;
}
export function matchesBlockedUrl(url: string, domains: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return true;
    if (parsed.protocol === 'file:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return true; }
}
export async function getPrivacySettings(): Promise<PrivacySettings> {
  const stored: unknown = (await chrome.storage.local.get(PRIVACY_KEY))[PRIVACY_KEY];
  if (stored === undefined) return { blockedDomains: [...DEFAULT_BLOCKED_DOMAINS], onboardingComplete: false };
  const settings = stored as PrivacySettings;
  if (!settings || !Array.isArray(settings.blockedDomains) || typeof settings.onboardingComplete !== 'boolean' ||
    !settings.blockedDomains.every(domain => typeof domain === 'string' && normalizeDomain(domain) === domain)) {
    throw new Error('Privacy settings could not be loaded. Reading is disabled.');
  }
  return settings;
}
export async function isBlockedUrl(url: string): Promise<boolean> {
  try { return matchesBlockedUrl(url, (await getPrivacySettings()).blockedDomains); }
  catch { return true; }
}
export async function canReadUrl(url: string): Promise<boolean> {
  try {
    const settings = await getPrivacySettings();
    return settings.onboardingComplete && !matchesBlockedUrl(url, settings.blockedDomains);
  } catch { return false; }
}
export function subscribePrivacy(listener: () => void): () => void {
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && PRIVACY_KEY in changes) listener();
  };
  chrome.storage.onChanged.addListener(changed);
  return () => chrome.storage.onChanged.removeListener(changed);
}
/** Fail closed immediately on changes; consumers reload before enabling reading. */
export function watchPagePrivacy(onChange: (allowed: boolean) => void): () => void {
  let revision = 0;
  let disposed = false;
  const refresh = (): void => {
    const current = ++revision;
    onChange(false);
    void canReadUrl(location.href).then(allowed => {
      if (!disposed && current === revision) onChange(allowed);
    });
  };
  const off = subscribePrivacy(refresh);
  refresh();
  return () => { disposed = true; off(); };
}
