/**
 * Who sent a message to the background worker.
 *
 * Content scripts run inside web pages, the least trusted part of the
 * extension: a compromised page process can send any message a content
 * script can. So anything that reads other tabs or controls the browser is
 * only answered for extension pages (the side panel), and page events are
 * only accepted from content scripts in a tab.
 */

import { normalizeUrl } from './normalize-url';

type Sender = Pick<chrome.runtime.MessageSender, 'tab' | 'url'>;

/** The side panel or another page of this extension. `origin` is chrome.runtime.getURL(''). */
export function isFromExtensionPage(sender: Sender, origin: string): boolean {
  return typeof sender.url === 'string' && sender.url.startsWith(origin);
}

/** A content script running in a browser tab. */
export function isFromTab(sender: Sender, origin: string): boolean {
  return sender.tab?.id !== undefined && !isFromExtensionPage(sender, origin);
}

/**
 * Whether `sender` may reach the notes saved for `url`.
 *
 * The URL arrives in the message payload, so on its own it says nothing
 * about who is asking. A content script may only reach the page it runs
 * on: it sends `location.href`, and `sender.url` is that same page as the
 * browser saw it, so the two are compared after normalization -- the same
 * function storage keys pages by. Without this a compromised page process
 * could read, write or orphan the notes saved for any other site.
 *
 * The side panel passes the URL of whichever tab it is showing, which is
 * the whole point of it, so it is trusted with any.
 */
export function mayReachUrl(sender: Sender, url: string, origin: string): boolean {
  if (isFromExtensionPage(sender, origin)) return true;
  if (!isFromTab(sender, origin) || sender.url === undefined) return false;
  try {
    return normalizeUrl(url) === normalizeUrl(sender.url);
  } catch {
    // An unsaveable URL on either side: never a match.
    return false;
  }
}
