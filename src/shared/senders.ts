/**
 * Who sent a message to the background worker.
 *
 * Content scripts run inside web pages, the least trusted part of the
 * extension: a compromised page process can send any message a content
 * script can. So anything that reads other tabs or controls the browser is
 * only answered for extension pages (the side panel), and page events are
 * only accepted from content scripts in a tab.
 */

type Sender = Pick<chrome.runtime.MessageSender, 'tab' | 'url'>;

/** The side panel or another page of this extension. `origin` is chrome.runtime.getURL(''). */
export function isFromExtensionPage(sender: Sender, origin: string): boolean {
  return typeof sender.url === 'string' && sender.url.startsWith(origin);
}

/** A content script running in a browser tab. */
export function isFromTab(sender: Sender, origin: string): boolean {
  return sender.tab?.id !== undefined && !isFromExtensionPage(sender, origin);
}
