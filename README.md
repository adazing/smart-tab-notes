# Smart Tab Notes

A Chrome extension that explains any line on a page using your other open tabs,
and keeps the answer pinned to the text it explains. The Python backend is in
[backend/](backend/README.md); API shapes are in [docs/api.md](docs/api.md).

## Setup

Node 20.19+ and Chrome 116+.

```bash
npm install
npm run build
```

Load it in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load
unpacked** → pick the `dist/` folder. Click the toolbar icon to open the side panel.

`npm run dev` rebuilds on save. Chrome doesn't hot-reload extensions, so after a
rebuild click reload on the extension card and reload any open tab you're testing.

| Command | What it does |
| --- | --- |
| `npm run build` | Typecheck, build into `dist/`, check it's loadable |
| `npm run dev` | Rebuild on change |
| `npm test` | Unit tests (Vitest) |
| `npm run test:browser` | Build, then toolbar and extractor tests in a real Chromium (run `npx playwright install chromium` once) |
| `npm run test:sites` | Run the page extractor on 10 real sites |
| `npm run test:anchors` | Save notes in a real Chromium, reload, check they come back; `-- --sites` adds five live sites |

## Layout

```
src/
  background/   service worker: answers the side panel, relays page events
  content/      runs in every page: selection toolbar, saved-note highlights
  extract/      page text extractor, injected only when a tab is read
  sidepanel/    React side panel (Chat, This page, Library)
  shared/       message bus, types, storage, getTabContext, chunker
backend/        FastAPI + LangGraph server
```

## Messages

Add a row when you add a message to `MessageContracts` in
[`src/shared/messages.ts`](src/shared/messages.ts). Shapes are in
[`src/shared/types.ts`](src/shared/types.ts).

| Kind | Direction | Request | Response |
| --- | --- | --- | --- |
| `ping` | any → any | `{ from }` | `{ ok, endpoint, at }` |
| `tabs:list` | side panel → background | `{ currentWindowOnly? }` | `{ tabs, groups }` |
| `tabs:getContext` | side panel → background | `{ tabIds }` | `{ contexts: TabContext[] }` (text and chunks per tab) |
| `tabs:getActive` | side panel → background | `{ windowId? }` | `{ tab }` |
| `tabs:focus` | side panel → background | `{ tabId }` | `Ack` |
| `tabs:changed` | background → side panels | `{ activeTabId, windowId }` | `Ack` |
| `page:getContext` | side panel → content | `{}` | `{ url, title, selection }` (for page text use `tabs:getContext`) |
| `page:getSelection` | side panel → content | `{}` | `{ selection }` |
| `page:selectionChanged` | content → background → side panels | `{ selection, tabId?, windowId? }` | `Ack` |
| `toolbar:action` | content → background | `{ action, text, url, question? }` (Explain and Ask only) | `Ack` |
| `annotations:save` | content → background | `{ url, title, text, note?, target? }` | `{ ok, annotation?, reason? }` |
| `annotations:list` | content/side panel → background | `{ url }` | `{ annotations, reason? }` |
| `annotations:update` | content → background | `{ id, note }` (`''` clears it) | `{ ok, annotation?, reason? }` |
| `annotations:delete` | content → background | `{ id }` | `Ack` |
| `annotations:anchorState` | content → background | `{ id, orphaned }` | `Ack` |
| `sidepanel:navigate` | any → side panel | `{ view }` | `Ack` |
| `sidepanel:ready` | side panel → background | `{}` | `Ack` |

Notes go through the worker because a content script's IndexedDB belongs to the
page's origin, not the extension. The background only answers `tabs:*` for
extension pages, and only accepts page events from tabs. Every open side panel
(one per window) gets every `tabs:changed` and `page:selectionChanged`;
`usePageState` ignores other windows and tabs.

## Storage

[`src/shared/storage.ts`](src/shared/storage.ts) (IndexedDB via Dexie). Every
record has a UUID `id`, `createdAt`, `updatedAt` and a `deleted` flag. URLs are
normalized (no `#hash`, tracking params or trailing slash).

| Function | Returns |
| --- | --- |
| `savePage({ url, title })` | The page, inserted or updated by normalized URL |
| `getPageByUrl(url)` | The page, or `undefined` |
| `addAnnotation({ pageId, text, note?, target?, explanation? })` | The new annotation |
| `listAnnotations(pageId)` | Annotations, oldest first |
| `updateAnnotation(id, { text?, note?, target?, explanation? })` | The annotation, or `undefined` |
| `setAnnotationOrphaned(id, orphaned)` | The stored flag. Derived from the page, so it leaves `updatedAt` alone |
| `softDelete(table, id)` | `false` if missing or already deleted |
| `addChatSummary({ pageId, summary })` | The new summary |
| `listChatSummaries(pageId?)` | Summaries, newest first |
| `createCollection({ name })` | The new collection |
| `listCollections()` | Collections, oldest first |

## Saved notes

Highlight and Note in the selection toolbar save a note and draw it. Each note
stores the W3C selector pair in `target`: a TextQuoteSelector (the quote plus 32
characters either side) and a TextPositionSelector. Both come from the page's
text with whitespace collapsed, which
[`src/content/textIndex.ts`](src/content/textIndex.ts) builds along with a map
back to the DOM.

On load, [`findAnchor`](src/shared/anchor.ts) looks for the quote where it was
saved, then anywhere the surrounding text agrees best, then fuzzily with
diff-match-patch (70% of it has to survive). What it finds is wrapped in
highlight spans, one per text node, styled inline with paint-only properties so
the page's layout and links are untouched. Hovering, clicking or tabbing to one
opens a card with the note, the AI explanation, Edit and Delete. A quote that
cannot be found is marked `orphaned` rather than deleted, and the side panel's
**This page** lists those.

Known rough edges:
- A fuzzy match can start or end a word or two off; the card says it's approximate.
- Overlapping highlights nest rather than merge.
- `explanation` is shown but nothing writes it yet (the explain flow is still a mock).
- Only the page's own DOM: no PDFs, iframes or other shadow roots.
- Stack Overflow blocks `npm run test:anchors -- --sites`, like `test:sites`.

## Page text extraction

`getTabContext(tabIds)` in [`src/shared/tabContext.ts`](src/shared/tabContext.ts)
returns each tab's text and ~500-token chunks, or a `status` saying why it
couldn't (`restricted`, `pdf`, `not_loaded`, `error`).

Sites that extract badly:
- **List pages** (e.g. the Hacker News front page) come out as a flat list of links.
- **PDFs** aren't supported yet.
- **Medium and Stack Overflow** block `npm run test:sites`; check them in Chrome with **This page → Extract text**.
