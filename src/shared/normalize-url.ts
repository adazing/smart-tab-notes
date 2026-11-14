const trackingParameters = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'gbraid', 'wbraid', 'mc_cid', 'mc_eid',
]);

/** Throws TypeError for invalid URLs or protocols other than HTTP(S). */
export function normalizeUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('Saved pages must use an absolute HTTP(S) URL');
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || trackingParameters.has(lower)) {
      url.searchParams.delete(key);
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}
