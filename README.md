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

## Layout

```
src/
  background/   service worker: answers the side panel, relays page events
  content/      runs in every page: selection toolbar, reports selections
  extract/      page text extractor, injected only when a tab is read
  sidepanel/    React side panel (Chat, This page, Library, Settings)
  shared/       message bus, types, storage, getTabContext, chunker
backend/        FastAPI + LangGraph server
```

## Messages

Add a row when you add a message to `MessageContracts` in
[`src/shared/messages.ts`](src/shared/messages.ts). Shapes are in
[`src/shared/types.ts`](src/shared/types.ts).

| Kind | Direction | Request | Response |
| --- | --- | --- | --- |
| `privacy:update` | side panel → background | `{ action, domain? }` | Persisted privacy settings |
| `data:cleared` | side panel → background → panel/content | `{ url? }` | `Ack` |
| `ping` | any → any | `{ from }` | `{ ok, endpoint, at }` |
| `tabs:list` | side panel → background | `{ currentWindowOnly? }` | `{ tabs, groups }` |
| `tabs:getContext` | side panel → background | `{ tabIds }` | `{ contexts: TabContext[] }` (text and chunks per tab) |
| `tabs:getActive` | side panel → background | `{ windowId? }` | `{ tab }` |
| `tabs:focus` | side panel → background | `{ tabId }` | `Ack` |
| `tabs:changed` | background → side panels | `{ activeTabId, windowId }` | `Ack` |
| `page:getContext` | side panel → content | `{}` | `{ url, title, selection }` (for page text use `tabs:getContext`) |
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


## Settings and privacy

Open **Settings** in the side panel to add or remove blocked websites, delete saved
content, or reopen privacy information. First-run **Continue** is required before
page reading and selection actions are enabled.

The default blocklist includes `mail.google.com`, `outlook.live.com`,
`outlook.office.com`, `mail.yahoo.com`, `chase.com`, `bankofamerica.com`,
`wellsfargo.com`, `capitalone.com`, and `citi.com`. This starter list is not
exhaustive. Add a hostname or HTTP(S) URL. Matching ignores casing, `www.`, ports,
paths, queries and fragments; it covers exact hosts and subdomains, so
`secure.chase.com` is blocked by `chase.com` but `notchase.com` is allowed.
Invalid and duplicate entries are rejected.

`shared/privacy.ts` centralizes settings, matching and subscriptions. Preferences
live in `chrome.storage.local` under `privacySettings`. Updates preserve users'
changes, including removed defaults. Missing or unavailable settings prevent
reading until privacy settings and onboarding permit it. Storage changes refresh
panels and dismiss blocked toolbars immediately.

Privacy checks protect extraction before injection, in the injected reader and
before returning content. They also protect selection/action messages and tab/group
listing. Content from newly blocked or closed tabs is discarded. Existing sender
validation and window-specific side-panel routing remain enforced. A future tab
picker should subscribe with `subscribePrivacy()`, reload `tabs:list`, remove
selected IDs absent from the returned list, and show an empty state if none remain.
All context must still pass through `tabs:getContext`.

**Clear This Page's Notes** confirms the active page URL, normalizes it with the
storage utility, and permanently deletes only that page's annotations, including
tombstones. Other pages, saved page records, summaries and collections remain.
**Clear All Data** permanently clears all four Dexie tables. Both actions require
in-panel confirmation, disable repeated submissions, and roll back transaction
failures. Privacy preferences and onboarding status remain. Panel content and
matching open pages' temporary toolbar UI are invalidated after deletion. Toolbar
saves are still temporary pending their storage integration; future sync writers
must not restore privacy-deleted records.

Tests cover matching, persistence, extraction races, toolbar changes, deletion,
confirmation/cancel/error states and onboarding. Run `npm test`, `npm run build`
and `npm run test:browser`. No lint command is configured. See
[the implementation record](docs/settings-privacy.md) for details and demo steps.
