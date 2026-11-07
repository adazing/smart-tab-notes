# browser-context
WICC technical committee p3 browser context

## Local storage

`src/shared/storage.ts` is the public storage API. Dexie wraps browser IndexedDB;
data stays on the device across browser sessions without a backend. Browser data
clearing or eviction can still remove it. No sync or authentication is implemented.

This branch started from `main`, which contained only this README. No PRD, shared
types, extension scaffold, lint configuration, or test tooling was available.
The following **provisional model** needs confirmation against the PRD:

| Table | Product fields | Indexes (in addition to UUID primary key `id`) |
| --- | --- | --- |
| `pages` | `url`, `title` | unique `url`, `updatedAt` |
| `annotations` | `pageId`, highlighted `text`, optional `note` | `pageId`, `updatedAt` |
| `chatSummaries` | `pageId`, `summary` | `pageId`, `createdAt`, `updatedAt` |
| `collections` | `name` | `createdAt`, `updatedAt` |

All records have a random UUID, `createdAt` and `updatedAt` (UTC epoch milliseconds),
and boolean `deleted`. Annotations and summaries require an active saved page.
Collection membership, highlight selectors, and conversation identifiers are left
undefined pending the PRD. No cascade deletion is assumed.

```ts
import { savePage, getPageByUrl, addAnnotation } from './shared/storage';

const page = await savePage({ url: 'https://example.com/article?utm_source=email', title: 'Article' });
const saved = await getPageByUrl('https://example.com/article');
const annotation = await addAnnotation({ pageId: page.id, text: 'Selected text', note: 'My note' });
```

| Function | Behavior |
| --- | --- |
| `savePage(input)` | Returns the saved page; atomically inserts or updates by normalized URL, preserving ID/creation time. Re-saving a deleted page restores it. |
| `getPageByUrl(url)` | Returns an active page or `undefined`. |
| `addAnnotation(input)` | Returns a new page-linked annotation. |
| `listAnnotations(pageId)` | Returns active annotations, oldest first. |
| `updateAnnotation(id, changes)` | Changes only `text`/`note`; returns the record, or `undefined` for missing/deleted IDs. Set `note` to `undefined` to clear it. |
| `softDelete(table, id)` | Supports all four table names; retains the record and advances `updatedAt`. Returns `false` for missing/already deleted records. |
| `addChatSummary(input)` | Returns a new page-linked summary. |
| `listChatSummaries(pageId?)` | Returns active summaries, newest first, optionally filtered by page. |
| `createCollection(input)` | Returns a new named collection. |
| `listCollections()` | Returns active collections, oldest first. |

Empty lists return `[]`. Timestamp ties use primary-key order (descending for
summaries). Mutations advance `updatedAt` by at least one millisecond, even within
one clock tick. Invalid relationships throw; database failures propagate as rejected
promises. Callers should catch errors at their UI/message boundary.

`normalizeUrl` removes fragments, case-insensitive `utm_*`, `fbclid`, `gclid`,
`dclid`, `msclkid`, `gbraid`, `wbraid`, `mc_cid`, and `mc_eid` parameters. It strips
trailing path slashes except `/`, uses standard URL protocol/hostname normalization,
and retains other parameters, their order, and path casing. It does not merge
HTTP/HTTPS or www/non-www URLs. Invalid, relative, and non-HTTP(S) URLs throw
`TypeError`. Both page reads and writes use this utility.

Normal reads exclude soft-deleted records. Deleting a page does not delete or hide
its children; they remain accessible by page ID. No public raw database access or
tombstone listing is provided. `src/shared/database.ts` centralizes schema version
1; add future versions with Dexie's `version(n).stores(...).upgrade(...)` rather
than modifying a released schema. Boolean `deleted` is filtered in memory after
indexed queries because IndexedDB does not index booleans.

The side panel and extension background context can import the public API directly
using the relative path for their module. Content scripts should send a typed
message to the extension background handler, which calls this API and returns the
result: content-script IndexedDB belongs to the host page's origin, not the
extension's database. That message integration belongs with the extension scaffold
and is not implemented here.

Run `npm ci`, then `npm run test:storage` for isolated Vitest tests using
`fake-indexeddb`, or `npm test` for the full suite. `npm run typecheck` checks all
TypeScript; `npm run build` emits the storage modules and declarations into ignored
`dist/`. This is a library build: no extension production packaging or lint command
exists on the base branch. Integrate with the extension build once its scaffold
is merged. Node 20.19+ is supported by this tooling.
