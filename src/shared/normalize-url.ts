const trackingParameters = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'gbraid', 'wbraid', 'mc_cid', 'mc_eid',
]);

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** Throws TypeError for invalid URLs or protocols other than HTTP(S). */
export function normalizeUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('Saved pages must use an absolute HTTP(S) URL');
  }
  url.hash = '';
  // Filter the raw query text rather than going through URLSearchParams, which
  // re-encodes every remaining parameter (%20 becomes +, ~ becomes %7E) and
  // would stop a clean revisit from matching the saved page.
  const kept = url.search
    .slice(1)
    .split('&')
    .filter((part) => {
      if (!part) return false;
      const key = safeDecode(part.split('=')[0]!).toLowerCase();
      return !key.startsWith('utm_') && !trackingParameters.has(key);
    });
  url.search = kept.length ? `?${kept.join('&')}` : '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}
