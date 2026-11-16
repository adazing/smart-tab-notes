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

### Backend

Explain, Ask and Chat call the Python backend at `http://localhost:8000`
(setup in [backend/README.md](backend/README.md)). With no OpenAI key, run the
mock instead: `npm run mock-backend` serves canned answers on the same port.
To use another URL, build with `VITE_API_URL=https://...` in `.env.local`, or
set it without rebuilding from the extension's service worker console:
`chrome.storage.local.set({ apiBaseUrl: 'http://localhost:8100' })`.

`npm run dev` rebuilds on save. Chrome doesn't hot-reload extensions, so after a
rebuild click reload on the extension card and reload any open tab you're testing.

| Command | What it does |
| --- | --- |
| `npm run build` | Typecheck, build into `dist/`, check it's loadable |
| `npm run dev` | Rebuild on change |
| `npm test` | Unit tests (Vitest) |
| `npm run test:browser` | Build, then toolbar, chat and extractor tests in a real Chromium against the mock backend (run `npx playwright install chromium` once) |
| `npm run test:sites` | Run the page extractor on 10 real sites |
| `npm run test:anchors` | Save notes in a real Chromium, reload, check they come back; `-- --sites` adds five live sites |
| `npm run mock-backend` | Fake backend on port 8000 with canned answers for `/explain`, `/chat` and `/rank-tabs` (no API key). A chat question containing "fail" returns an error event |

## Layout

```
src/
  background/   service worker: answers the side panel, relays page events,
                runs Explain/Ask (explain.ts) and owns saved notes (notes.ts)
  content/      runs in every page: selection menu, saved-note highlights and cards
  extract/      page text extractor, injected only when a tab is read
  sidepanel/    React side panel (Chat, This page, Library)
  shared/       message bus, types, storage, getTabContext, chunker,
                backend client (api.ts) and its URL (config.ts)
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
| `explain:run` | content → background | `{ text, url, question? }` | `{ ok, explanation, sources }` or `{ ok: false, error }` |
| `annotations:save` | content → background | `{ url, title, text, note?, target?, explanation?, question?, sources? }` | `{ ok, annotation?, reason? }` |
| `annotations:list` | content/side panel → background | `{ url }` | `{ annotations, reason? }` |
| `annotations:update` | content/side panel → background | `{ id, note?, explanation?, question?, sources? }` (`note: ''` clears it) | `{ ok, annotation?, reason? }` |
| `annotations:delete` | content/side panel → background | `{ id }` | `Ack` |
| `annotations:anchorState` | content → background | `{ id, orphaned }` | `Ack` |
| `annotations:changed` | background → side panels and tabs on that page | `{ url }` | `Ack` |
| `annotations:reveal` | side panel → content | `{ id }` | `Ack` (scrolls to the highlight and opens its card) |
| `sidepanel:navigate` | any → side panel | `{ view }` | `Ack` |
| `sidepanel:ready` | side panel → background | `{}` | `Ack` |

The background only answers `tabs:*` for extension pages, and only accepts page
events from tabs. Every open side panel (one per window) gets every
`tabs:changed` and `page:selectionChanged`; `usePageState` ignores other windows
and tabs.

**Notes are highlights.** The selection menu is Explain, Ask and Highlight.
Everything saved goes through the annotation layer
([`content/annotationLayer.ts`](src/content/annotationLayer.ts)), so it is drawn
on the page and comes back on every visit. Clicking a highlight opens its card:
note, AI answer, source tabs, Add/Edit note, Explain (if it has no explanation
yet) and Delete. Notes go through the worker
([`background/notes.ts`](src/background/notes.ts)) because a content script's
IndexedDB belongs to the page's origin. A content script may only read or change
notes on its own tab's page; the side panel may change any.

**Explain and Ask.** For `explain:run` the worker, not the page, picks what to
read: the sender's tab plus up to 8 other loaded tabs in its window (its tab
group first, then most recently used), via `getTabContext`, then calls
`POST /explain`. It refuses if the tab's URL no longer matches the selection's.
Because page scripts can click inside the open shadow roots of the menu and the
card, Explain, Ask and saving only run within a second of a real (trusted)
pointer or key event inside them.

## Chat

The Chat view ([`views/ChatView.tsx`](src/sidepanel/views/ChatView.tsx)) calls
`POST /chat` and `POST /rank-tabs` straight from the side panel
([`shared/api.ts`](src/shared/api.ts)); docs/api.md has the shapes.

- **Tabs.** The tabs a question uses are tags above the input; the current tab
  is one by default, and **+ Add tab** lists the rest of the window. While you
  type, other tabs are scored by `/rank-tabs` and suggested ones appear as
  one-click **+ title** buttons, used only once clicked. Ranking sends only
  titles and origin + path.
- **Reading.** Tabs are read (`tabs:getContext`) only when you send. Tabs that
  can't be read are listed under the answer as skipped, with the reason.
- **Citations.** `[chunk_id]` markers become numbered chips as they stream in
  ([`citations.ts`](src/sidepanel/citations.ts)); the `done` event's numbers win.
  Clicking a chip focuses that tab, or reopens its URL if it has closed.
- The last 5 answered exchanges go with each question. The conversation lives in
  memory: it survives switching views, not closing the panel.

## Storage

[`src/shared/storage.ts`](src/shared/storage.ts) (IndexedDB via Dexie). Every
record has a UUID `id`, `createdAt`, `updatedAt` and a `deleted` flag. URLs are
normalized (no `#hash`, tracking params or trailing slash).

| Function | Returns |
| --- | --- |
| `savePage({ url, title })` | The page, inserted or updated by normalized URL |
| `getPageByUrl(url)` | The page, or `undefined` |
| `addAnnotation({ pageId, text, note?, target?, explanation?, question?, sources? })` | The new annotation |
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
- **Medium and Stack Overflow** block `npm run test:sites`; check them in the browser with **This page → Developer tools → Extract text**.
