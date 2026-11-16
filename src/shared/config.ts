/**
 * Where the Python backend lives.
 *
 * Default: `VITE_API_URL` at build time (put it in `.env.local`), else
 * http://localhost:8000. A `apiBaseUrl` string in chrome.storage.local
 * overrides it without a rebuild, which the browser tests use to point the
 * extension at a mock server.
 */

export const DEFAULT_API_BASE_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:8000';

export const API_BASE_URL_KEY = 'apiBaseUrl';

function clean(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function getApiBaseUrl(): Promise<string> {
  try {
    const stored = (await chrome.storage.local.get(API_BASE_URL_KEY))[API_BASE_URL_KEY];
    if (typeof stored === 'string' && /^https?:\/\//.test(stored.trim())) return clean(stored);
  } catch {
    // No chrome.storage (unit tests): use the default.
  }
  return clean(DEFAULT_API_BASE_URL);
}
