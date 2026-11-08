# Smart Tab Notes

A Chrome extension that explains any line on a page using your other open tabs,
and keeps the answer pinned to the text it explains.

This repo is the scaffold everyone builds into: a Manifest V3 extension in
TypeScript, a side panel with three empty views, and a typed message bus
between the content scripts, the background worker and the side panel.

---

## Setup

Node 18, 20 or 22+ (Vite 6 requirement). Chrome 116 or newer.

```bash
git clone <repo-url>
cd smart-tab-notes
npm install
npm run build
```

Then load it in Chrome:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `dist/` folder — not the repo root.
4. Pin **Smart Tab Notes** to the toolbar and click the icon. The side panel opens.

While working, `npm run dev` rebuilds on save. Chrome does not hot-reload
extensions: after a rebuild, hit the reload arrow on the extension card in
`chrome://extensions`, and reload any tab whose content script changed.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Typecheck, build into `dist/`, then check `dist/` is loadable |
| `npm run dev` | Same build, rebuilding on change (no typecheck) |
| `npm run typecheck` | `tsc --noEmit` over `src/` and over the build tooling |
| `npm run verify` | Check `dist/` against the manifest without rebuilding |
| `npm test` | Unit tests (Vitest) |
| `npm run test:sites` | Run the page extractor against 10 real sites (see [Page text and tabs](#page-text-and-tabs)) |
| `npm run icons` | Regenerate the toolbar icons into `public/icons` |
| `npm run clean` | Delete `dist/` |

---

## Layout

```
src/
  background/   service worker: tab queries, message relay, side panel behaviour
  content/      injected into every http(s) page: reads the page, reports selections
  extract/      Readability-based page extractor, injected on demand by getTabContext
  sidepanel/    the React side panel and its three views
  shared/       message bus, data types, tab helpers, getTabContext and the chunker
public/         manifest.json and icons, copied to dist/ as-is
scripts/        build orchestration, icon generation, dist checks
sidepanel.html  side panel entry point (Vite needs it at the repo root)
```

### Why there are three Vite configs

`vite.config.ts` builds the side panel and the background worker. Both are ES
modules in the packaged extension, so Vite may split shared code into chunks.

`vite.content.config.ts` builds the content script on its own, in IIFE format.
Chrome injects content scripts as classic scripts, so they cannot `import`
anything at runtime — everything they touch has to be inlined into one file.

`vite.extract.config.ts` builds `extract.js` the same way. It bundles Mozilla
Readability (~37 KB) and is injected only when `getTabContext` reads a tab, so
it is kept out of the content script that runs on every page.

`npm run verify` fails the build if an `import` ever shows up in `content.js`
or `extract.js`. `scripts/build.mjs` runs the builds in that order: the main
build empties `dist/` and copies `public/`, and the other two add to it.

---

## The message bus

Everything crossing between the three parts of the extension goes through
[`src/shared/messages.ts`](src/shared/messages.ts). Don't call
`chrome.runtime.sendMessage` directly — the helpers give you request and
response types, and they turn "nobody was listening" into a value instead of an
unhandled rejection.

### Sending

```ts
import { sendToBackground, sendToTab, notify } from '../shared/messages';

const result = await sendToBackground('tabs:list', { currentWindowOnly: true });
if (result.ok) {
  console.log(result.data.tabs); // typed as TabRef[]
} else {
  console.warn(result.error);
}

// To a specific tab's content script:
await sendToTab(tabId, 'page:getContext', { includeText: true });

// Fire and forget, when you don't need a reply:
await notify('sidepanel', 'tabs:changed', { activeTabId: 42 });
```

Sends resolve to `{ ok: true, data }` or `{ ok: false, error }`. They never
throw. A closed side panel or a `chrome://` tab with no content script is
normal, not a bug — use `isNoReceiverError(result.error)` to tell that apart
from a real failure.

### Receiving

```ts
import { registerHandlers } from '../shared/messages';

registerHandlers('background', {
  'tabs:focus': async ({ tabId }) => {
    await chrome.tabs.update(tabId, { active: true });
    return { ok: true };
  },
});
```

The first argument is which endpoint you are. `chrome.runtime.sendMessage`
reaches every extension page, so each message carries a target and handlers
ignore anything not addressed to them.

Handlers may be async. **Register at most one handler per (endpoint, kind)
pair** — a second one races the first to answer. In React, register inside
`useEffect` and return the unsubscribe function.

### Message types

Add a row here whenever you add a message. `→` is the direction it travels.

| Kind | Direction | Request | Response | Notes |
| --- | --- | --- | --- | --- |
| `ping` | any → any | `{ from: Endpoint }` | `{ ok, endpoint, at }` | Health check. Handled by background and content. |
| `tabs:list` | side panel → background | `{ currentWindowOnly?: boolean }` | `{ tabs: TabRef[], groups: TabGroupRef[] }` | Backs the sidebar tab list. |
| `tabs:getContext` | any → background | `{ tabIds: number[] }` | `{ contexts: TabContext[] }` | Readable text and chunks per tab, in order. See [Page text and tabs](#page-text-and-tabs). |
| `tabs:getActive` | side panel → background | `{}` | `{ tab: TabRef \| null }` | The tab in view. |
| `tabs:focus` | side panel → background | `{ tabId: number }` | `Ack` | Backs "clicking a citation opens that tab". |
| `tabs:changed` | background → side panel | `{ activeTabId: number \| null }` | `Ack` | Fired on tab switch, page load and window focus. |
| `page:getContext` | side panel/background → content | `{ includeText?: boolean, maxChars?: number }` | `PageContext` | Page text is only read when `includeText` is set. |
| `page:getSelection` | side panel/background → content | `{}` | `{ selection: SelectionInfo \| null }` | |
| `page:selectionChanged` | content → background → side panel | `{ selection: SelectionInfo \| null, tabId?: number }` | `Ack` | Debounced 250ms. The worker stamps `tabId`. |
| `sidepanel:navigate` | any → side panel | `{ view: SidePanelView }` | `Ack` | Brings a view to the front. |
| `sidepanel:ready` | side panel → background | `{}` | `Ack` | Sent once the panel mounts. |

Shared shapes (`TabRef`, `TabGroupRef`, `PageContext`, `SelectionInfo`, `TabContext`, `TextChunk`, `Ack`)
live in [`src/shared/types.ts`](src/shared/types.ts).

### Adding a message

1. Add an entry to `MessageContracts` in `src/shared/messages.ts`.
2. Register a handler on the receiving endpoint.
3. Add a row to the table above.

Steps 1 and 2 are enough for TypeScript to catch a wrong payload at either end.

---

## Side panel

Opens from the toolbar icon. The worker calls
`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` on every
start, which makes an icon click toggle the panel without any click handler.

Three views, switched by the nav in the header:

| View | Status | Owner |
| --- | --- | --- |
| **Chat** | Empty placeholder | Chat ticket |
| **This page** | Shows the active tab, the live selection and an **Extract text** debug card | Annotations / recap tickets |
| **Library** | Empty placeholder | Saved pages and collections ticket |

"This page" also has a **Ping this page** button. It is a connection check, not
a product feature: it round-trips a message to the content script in the active
tab, so you can tell a broken build from a missing reload. Delete it once the
real view lands.

To add a view: add it to `SidePanelView` in `src/shared/types.ts`, add a label
to `SIDE_PANEL_VIEW_LABELS`, and render it in `src/sidepanel/App.tsx`. The nav
is generated from that list.

Views should read tab state from the `usePageState` hook rather than calling
`chrome.tabs` themselves, so there is one path to keep correct.

---

## Page text and tabs

Everything that sends page content to the AI goes through one function in
[`src/shared/tabContext.ts`](src/shared/tabContext.ts):

```ts
import { getTabContext } from '../shared/tabContext';

const [page, ...others] = await getTabContext([activeTabId, 12, 15]);
if (page.status === 'ok') {
  page.text;    // readable text, blocks separated by blank lines
  page.chunks;  // [{ id: 't12-c0', heading: 'Overview', text, tokenEstimate }, ...]
}
```

It uses `chrome.tabs` and `chrome.scripting`, so call it from the background
worker or the side panel. From a content script, send `tabs:getContext`.

**What it does per tab**

1. Skips tabs it cannot or should not read, returning only title and URL with a
   `status`. It never throws, and results come back in the order of `tabIds`.

   | `status` | When |
   | --- | --- |
   | `ok` | Text extracted |
   | `not_loaded` | Chrome discarded the tab, or it has not loaded since a restart (`loaded: false`) |
   | `restricted` | `chrome://`, the Web Store, and other non-http(s) pages |
   | `pdf` | URL ends in `.pdf`, or the page's content type is `application/pdf` |
   | `error` | Tab closed, `file://` without file access, error pages; see `error` |

2. Injects `dist/extract.js` with `chrome.scripting.executeScript`. On Stack
   Overflow and other Stack Exchange sites it reads the question and each answer
   directly (`extractor: 'stack-exchange'`), because Readability keeps only the
   top answer there. Everywhere else it runs
   [Mozilla Readability](https://github.com/mozilla/readability) on a copy of the
   page. If Readability finds no article (under 50 words), it falls back to the
   page's visible text, skipping nav, footers, forms and hidden elements.
   `extractor` says which was used. Text is capped at 200,000 characters
   (`truncated: true`).
3. Readability tends to drop section headings (anything with an anchor or
   `[edit]` link), so headings are restored from the original page.
4. Splits the text into chunks of about 500 tokens (characters / 4), each with
   the nearest heading above it. Short sections are merged, and long paragraphs
   are split on sentence boundaries. Chunk ids are `t<tabId>-c<index>`, so they
   are unique across tabs for citations.

Tabs and groups: `listTabs()` and `listTabGroups()` in
[`src/shared/tabs.ts`](src/shared/tabs.ts) (also behind `tabs:list`). Each
`TabRef` has `tabId`, `title`, `url`, `groupId`, `accessible` and `loaded`, and
each group has `groupId`, `title`, `color` and its `tabIds`.

Privacy: pages are only read when `getTabContext` is called for them. The
**Extract text** card in the This page view calls it for the active tab, so you
can check a site by hand.

### Site results

`npm run test:sites` fetches each page's HTML and runs the same extractor in
jsdom. jsdom does not run page JavaScript, so treat this as a lower bound and
check client-rendered sites with the side panel's **Extract text** button.

| Site | Result | Notes |
| --- | --- | --- |
| Wikipedia (Backpropagation) | Good (checked in Chrome) | 5.6k words, 26 chunks, section headings correct. In live Chrome Readability flattens headings into "Heading [edit]" lines; these are turned back into headings (fixed after the Chrome check, not yet re-checked in Chrome). Math formulas come out as flattened symbols (`Wl=(wjkl)`). |
| arXiv abstract page | Good | Title and abstract. Includes link text such as "View PDF HTML (experimental)". |
| MDN (Fetch API) | Good | All 9 section headings. |
| GitHub README (mozilla/readability) | Good (checked in Chrome) | README only, no file list or repo menus. Code blocks kept. Also correct after GitHub's in-page navigation (no full page load). |
| Python docs (Classes) | Good | 5.3k words, 18 headings (`¶` stripped). |
| react.dev (Quick Start) | Good | Server-rendered, so it works without JS. Code samples come through as text. |
| Paul Graham essay | OK | 11.8k words but no headings (the essay has none), so chunks have `heading: ''`. Old table layout is handled. |
| Hacker News front page | Poor (checked in Chrome) | Not an article: a flat list of titles, points and "hide". Expected for list pages. Readability still accepts it, so the visible-text fallback is not used here. |
| Medium article | Good (checked in Chrome) | 2.2k words, 9 chunks, headings correct. The first chunk starts with byline clutter ("9 min read Nov 11, 2017"). Returns 403 to `test:sites`. |
| Stack Overflow question | Good (checked in Chrome) | Uses a Stack Exchange rule instead of Readability, which kept only the top answer. 10.4k words, 42 chunks: the question (with its code), then each answer under "Answer N (accepted)" headings. Comments, votes and sidebars are left out. Returns 403 to `test:sites`. |

Also checked in Chrome: an arXiv PDF without a `.pdf` URL (`arxiv.org/pdf/1706.03762`) reports
`pdf` from its content type, and the New Tab page reports `restricted`. Neither crashes.

Not yet checked in a real browser: the visible-text fallback (none of the sites above
needed it) and `not_loaded` tabs.

Not supported yet: PDFs, and text inside iframes (only the top frame is read).

---

## Permissions

Declared in [`public/manifest.json`](public/manifest.json):

| Permission | Why |
| --- | --- |
| `sidePanel` | The side panel itself |
| `tabs` | Titles and URLs of other tabs, for multi-tab context |
| `tabGroups` | Tab group summaries |
| `storage` | Notes, chat summaries and collections (local only in v1) |
| `scripting` | Injecting into tabs the user confirms |
| `activeTab` | Acting on the current tab from a user gesture |

`host_permissions` is `http://*/*` and `https://*/*`, which the content script
needs in order to run at all.

The content script is registered on every page, but it is **passive**: it
answers questions the side panel asks and reports text the user has
deliberately selected. It does not scrape or transmit page content on its own.
That is deliberate — the PRD decision is that tabs are never read silently, and
reading only happens on a user action or after the user confirms a tab. Keep it
that way when you build on it.

---

## Not in the scaffold

Called out so nobody assumes they are handled:

- **No storage layer.** Nothing is persisted yet; `storage` is only declared.
- **No AI calls**, no API key handling, no cost tracking.
- **No highlight anchoring.** The content script returns a quote plus ~120
  characters either side, which is the shape of a W3C TextQuoteSelector but not
  a real implementation — it finds the first match of the text within its
  containing element. The anchoring ticket replaces it.
- **No blocked-site list.** The PRD calls for users to block sensitive sites
  (banking, email, health); there is no mechanism for it yet.
- **No PDF support.** Chrome's built-in viewer does not accept content scripts;
  this is still an open question in the PRD. `getTabContext` reports PDFs as
  `status: 'pdf'` instead of failing.
- **Side panel is global, not per tab.** One panel for the whole window. If a
  view needs per-tab state, key it by tab id yourself.
