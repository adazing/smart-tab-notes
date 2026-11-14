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
| `npm run test:browser` | Toolbar test in a real Chromium (run `npx playwright install chromium` once) |
| `npm run test:sites` | Run the page extractor on 10 real sites |

## Layout

```
src/
  background/   service worker: answers the side panel, relays page events
  content/      runs in every page: selection toolbar, reports selections
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
| `page:getContext` | side panel → content | `{ includeText?, maxChars? }` | `PageContext` |
| `page:getSelection` | side panel → content | `{}` | `{ selection }` |
| `page:selectionChanged` | content → background → side panels | `{ selection, tabId?, windowId? }` | `Ack` |
| `toolbar:action` | content → background | `{ action, text, url, question?, note? }` | `Ack` |
| `sidepanel:navigate` | any → side panel | `{ view }` | `Ack` |
| `sidepanel:ready` | side panel → background | `{}` | `Ack` |

The background only answers `tabs:*` for extension pages, and only accepts page
events from tabs. Every open side panel (one per window) gets every
`tabs:changed` and `page:selectionChanged`; `usePageState` ignores other windows
and tabs.

## Storage

[`src/shared/storage.ts`](src/shared/storage.ts) (IndexedDB via Dexie). Every
record has a UUID `id`, `createdAt`, `updatedAt` and a `deleted` flag. URLs are
normalized (no `#hash`, tracking params or trailing slash).

| Function | Returns |
| --- | --- |
| `savePage({ url, title })` | The page, inserted or updated by normalized URL |
| `getPageByUrl(url)` | The page, or `undefined` |
| `addAnnotation({ pageId, text, note? })` | The new annotation |
| `listAnnotations(pageId)` | Annotations, oldest first |
| `updateAnnotation(id, { text?, note? })` | The annotation, or `undefined` |
| `softDelete(table, id)` | `false` if missing or already deleted |
| `addChatSummary({ pageId, summary })` | The new summary |
| `listChatSummaries(pageId?)` | Summaries, newest first |
| `createCollection({ name })` | The new collection |
| `listCollections()` | Collections, oldest first |

## Page text extraction

`getTabContext(tabIds)` in [`src/shared/tabContext.ts`](src/shared/tabContext.ts)
returns each tab's text and ~500-token chunks, or a `status` saying why it
couldn't (`restricted`, `pdf`, `not_loaded`, `error`).

Sites that extract badly:
- **List pages** (e.g. the Hacker News front page) come out as a flat list of links.
- **PDFs** aren't supported yet.
- **Medium and Stack Overflow** block `npm run test:sites`; check them in Chrome with **This page → Extract text**.
