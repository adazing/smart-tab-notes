/**
 * Saved notes in the real extension: save, reload, and come back.
 *
 * The fixture is served from a route so the same URL can return changed
 * text on a later load -- the same thing as editing the page in devtools,
 * but repeatable. One version reflows and rewords the page, another takes
 * the quoted sentence away entirely, which is the orphan case.
 *
 * `npm run test:anchors` runs the same checks through the Playwright
 * library instead of its test runner, which is what to reach for when the
 * runner will not start (it needs Node 20.19+).
 */
import { chromium, expect, test, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const HIGHLIGHT = '[data-smart-tab-notes-highlight]';
const CARD = '#smart-tab-notes-annotations .card';
const TOOLBAR = '#smart-tab-notes-selection-toolbar .panel';

const HEAD =
  '<style>body{margin:0;font-family:serif;max-width:40em}p{line-height:1.6}</style>' +
  '<title>Anchoring fixture</title>';

/** The page as it is when the notes are saved. */
const VERSION_1 =
  HEAD +
  '<h1>Attention and memory</h1>' +
  '<p id="p1">Transformers replaced <a href="/rnn">recurrent networks</a> entirely, ' +
  'and attention is all you need.</p>' +
  '<p id="p2">The model scales quadratically with sequence length, which is why long ' +
  'documents are expensive.</p>' +
  '<p id="p3">Sparse attention trades exactness for speed on very long inputs.</p>';

/** The same page after an edit: a new paragraph above, and a reworded sentence. */
const VERSION_2 =
  HEAD +
  '<h1>Attention and memory</h1>' +
  '<p id="p0">An opening paragraph that was not there before, pushing everything down.</p>' +
  '<p id="p1">Transformers replaced <a href="/rnn">recurrent networks</a> entirely, ' +
  'and attention is all you need.</p>' +
  '<p id="p2">The model scales quadratically with the sequence length, which is why long ' +
  'documents get expensive.</p>' +
  '<p id="p3">Sparse attention trades exactness for speed on very long inputs.</p>';

/** The same page with the third sentence gone for good. */
const VERSION_3 =
  HEAD +
  '<h1>Attention and memory</h1>' +
  '<p id="p1">Transformers replaced <a href="/rnn">recurrent networks</a> entirely, ' +
  'and attention is all you need.</p>' +
  '<p id="p2">The model scales quadratically with sequence length, which is why long ' +
  'documents are expensive.</p>' +
  '<p id="p3">This paragraph now discusses the migratory patterns of arctic terns, ' +
  'which is a different subject altogether.</p>';

let context: BrowserContext;
let profile: string;

test.beforeAll(async () => {
  profile = await mkdtemp(resolve(tmpdir(), 'smart-tab-notes-anchoring-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    // Playwright's default args include --disable-extensions, which cancels
    // --load-extension and leaves a browser with no extension in it.
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
});

test.afterAll(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

/**
 * Our own service worker. A profile runs several extensions' workers, more
 * than one of them called background.js, so pick ours by name.
 */
async function ourWorker(): Promise<Worker> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      const name = await worker
        .evaluate(() => {
          const api = (globalThis as {
            chrome?: { runtime?: { getManifest(): { name: string } } };
          }).chrome;
          return api?.runtime?.getManifest().name ?? null;
        })
        .catch(() => null);
      if (name === 'Smart Tab Notes') return worker;
    }
    await context.waitForEvent('serviceworker', { timeout: 5_000 }).catch(() => undefined);
  }
  throw new Error('the extension service worker never started');
}

/**
 * Put the toolbar away. Escape closes its popover first and the toolbar
 * second, so press until it is gone: a toolbar still showing the previous
 * selection would act on that one.
 */
async function dismissToolbar(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4 && await page.locator(TOOLBAR).isVisible(); attempt += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

/** Close the note card, so it cannot sit on top of what we click next. */
async function closeCard(page: Page): Promise<void> {
  if (await page.locator(CARD).isVisible()) {
    await page.keyboard.press('Escape');
    await expect(page.locator(CARD)).toBeHidden();
  }
}

/** Select the contents of an element the way a user's drag would. */
async function select(page: Page, selector: string): Promise<void> {
  await closeCard(page);
  await dismissToolbar(page);
  const element = page.locator(selector).first();
  await element.scrollIntoViewIfNeeded();
  await element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator(TOOLBAR)).toBeVisible();
}

/**
 * A saved highlight draws itself and opens its card: that is the
 * confirmation, because wrapping the text collapses the selection the
 * toolbar was positioned against.
 */
async function highlight(page: Page, selector: string): Promise<void> {
  await select(page, selector);
  await page.locator(TOOLBAR).getByRole('button', { name: 'Note', exact: true }).click();
  await expect(page.locator(CARD)).toBeVisible();
  await closeCard(page);
  await dismissToolbar(page);
}

async function addNote(page: Page, selector: string, note: string): Promise<void> {
  await select(page, selector);
  // Every note is a highlight: Highlight opens the card with its note box ready.
  await page.locator(TOOLBAR).getByRole('button', { name: 'Note', exact: true }).click();
  const card = page.locator(CARD);
  await card.getByLabel('Note about this text').fill(note);
  await card.getByRole('button', { name: 'Save note' }).click();
  await expect(card).toContainText(note);
  await closeCard(page);
  await dismissToolbar(page);
}

/**
 * The notes drawn on the page: one entry per note, in page order, with all
 * of its spans joined. A sentence with a link in it is three spans, so
 * counting or indexing spans would say nothing useful.
 */
async function drawnNotes(page: Page): Promise<{ id: string; text: string }[]> {
  return await page.locator(HIGHLIGHT).evaluateAll((spans) => {
    const byNote = new Map<string, string>();
    for (const span of spans) {
      const id = span.getAttribute('data-smart-tab-notes-highlight') ?? '';
      byNote.set(id, (byNote.get(id) ?? '') + (span.textContent ?? ''));
    }
    return [...byNote].map(([id, text]) => ({ id, text }));
  });
}

async function drawn(page: Page): Promise<string[]> {
  return (await drawnNotes(page)).map((note) => note.text);
}

/** The first span of one note: the handle to hover or click. */
function spanOf(page: Page, id: string): Locator {
  return page.locator(`[data-smart-tab-notes-highlight="${id}"]`).first();
}

/** Read the extension's own database, oldest note first. */
async function storedNotes(): Promise<{ text: string; orphaned?: boolean }[]> {
  const worker = await ourWorker();
  return await worker.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((done, fail) => {
      const request = indexedDB.open('smart-tab-notes');
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
    });
    try {
      const rows = await new Promise<
        { text: string; deleted: boolean; orphaned?: boolean; createdAt: number }[]
      >((done, fail) => {
        const request = database.transaction('annotations').objectStore('annotations').getAll();
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      // getAll comes back in UUID order, which is no order at all.
      return rows
        .filter((row) => !row.deleted)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((row) => ({ text: row.text, orphaned: row.orphaned }));
    } finally {
      database.close();
    }
  });
}

const QUOTES = [
  'Transformers replaced recurrent networks entirely, and attention is all you need.',
  'The model scales quadratically with sequence length, which is why long documents are expensive.',
  'Sparse attention trades exactness for speed on very long inputs.',
];

test('saved notes come back on reload, follow a changed page, and are kept when the text goes', async () => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  let body = VERSION_1;
  await page.route('https://anchor.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body }));
  await page.goto('https://anchor.test/');
  await expect(page.locator('#smart-tab-notes-annotations')).toHaveCount(1);

  /* ---- save three notes ------------------------------------------- */
  const originalText = await page.locator('body').innerText();
  const originalMarkup = await page.locator('#p1').innerHTML();

  await highlight(page, '#p1');
  await addNote(page, '#p2', 'Why squared?');
  await highlight(page, '#p3');

  // Drawn immediately, and the page itself is untouched apart from the spans.
  expect(await drawn(page)).toEqual(QUOTES);
  expect(await page.locator('body').innerText()).toBe(originalText);
  expect(await page.locator('#p1 a').getAttribute('href')).toBe('/rnn');
  expect(await page.locator('#p1').innerHTML()).not.toBe(originalMarkup);

  /* ---- the note card ---------------------------------------------- */
  const card = page.locator(CARD);
  const second = (await drawnNotes(page))[1]!;
  // Start the pointer off the text: the toolbar we just used can leave it
  // resting on this highlight already, and then hover() fires no mouseover.
  await page.mouse.move(0, 0);
  await spanOf(page, second.id).hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Why squared?');
  // No explanation yet, so the card offers to make one.
  await expect(card.getByRole('button', { name: 'Explain', exact: true })).toBeVisible();

  // Clicking pins the card open, so Edit note can be reached.
  await closeCard(page);
  await spanOf(page, second.id).click();
  await card.getByRole('button', { name: 'Edit note' }).click();
  await card.getByLabel('Note about this text').fill('Because every token attends to every other.');
  await card.getByRole('button', { name: 'Save note' }).click();
  await expect(card).toContainText('Because every token attends to every other.');
  await closeCard(page);

  /* ---- reload: the notes come back -------------------------------- */
  await page.reload();
  await expect(page.locator(HIGHLIGHT).first()).toBeAttached();
  expect(await drawn(page)).toEqual(QUOTES);
  expect(await page.locator('body').innerText()).toBe(originalText);
  await page.mouse.move(0, 0);
  await spanOf(page, (await drawnNotes(page))[1]!.id).hover();
  await expect(card).toContainText('Because every token attends to every other.');
  await closeCard(page);

  /* ---- the page changes under them -------------------------------- */
  body = VERSION_2;
  await page.reload();
  await expect(page.locator(HIGHLIGHT).first()).toBeAttached();
  const afterEdit = await drawnNotes(page);
  expect(afterEdit).toHaveLength(3);
  // Moved down by the new paragraph, and still exactly on its own sentence.
  expect(afterEdit[0]!.text).toBe(QUOTES[0]);
  // Reworded: found by fuzzy matching, on the new wording and nothing more.
  expect(afterEdit[1]!.text).toBe(
    'The model scales quadratically with the sequence length, which is why long documents ' +
    'get expensive.');
  expect(afterEdit[2]!.text).toBe(QUOTES[2]);

  await page.mouse.move(0, 0);
  await spanOf(page, afterEdit[1]!.id).hover();
  await expect(card).toContainText('The page has changed here');
  await closeCard(page);

  /* ---- live edit, as devtools would do it ------------------------- */
  await page.locator('#p3').evaluate((node) => {
    node.textContent = 'Sparse attention trades exactness for raw speed on extremely long inputs.';
  });
  await expect(async () => {
    expect(await drawn(page)).toContain(
      'Sparse attention trades exactness for raw speed on extremely long inputs.');
  }).toPass({ timeout: 15_000 });

  /* ---- the text goes away: the note is kept, marked orphaned ------ */
  body = VERSION_3;
  await page.reload();
  await expect(page.locator(HIGHLIGHT).first()).toBeAttached();
  const afterRemoval = await drawn(page);
  expect(afterRemoval).toHaveLength(2);
  expect(afterRemoval.some((text) => text.includes('Sparse attention'))).toBe(false);

  await expect(async () => {
    const stored = await storedNotes();
    expect(stored).toHaveLength(3);
    expect(stored.filter((note) => note.orphaned === true)).toEqual([
      { text: QUOTES[2], orphaned: true },
    ]);
  }).toPass({ timeout: 15_000 });

  /* ---- deleting one takes its highlight out ----------------------- */
  const kept = await drawnNotes(page);
  await closeCard(page);
  await spanOf(page, kept[0]!.id).click();
  await card.getByRole('button', { name: 'Delete' }).click();
  await card.getByRole('button', { name: 'Really delete?' }).click();
  await expect(spanOf(page, kept[0]!.id)).toBeHidden();
  expect(await drawn(page)).toHaveLength(1);

  await page.reload();
  await expect(page.locator(HIGHLIGHT).first()).toBeAttached();
  expect(await drawn(page)).toHaveLength(1);
  expect(await storedNotes()).toHaveLength(2);

  expect(errors).toEqual([]);
  await page.close();
});
