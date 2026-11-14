/**
 * Checks saved notes against real pages, in the real extension.
 *
 *   npm run test:anchors              the offline fixture only
 *   npm run test:anchors -- --sites   the fixture, then the five sites below
 *   npm run test:anchors -- <url>...  the fixture, then the URLs you give
 *
 * This drives Chromium with dist/ loaded as an unpacked extension, exactly
 * as `npm run test:browser` does. It exists alongside those Playwright
 * specs because the Playwright *runner* needs Node 20.19+, while this
 * script only needs the library, so it still runs on Node 20.17. Build
 * first: it checks the dist/ you have.
 *
 * The fixture serves three versions of one URL: as saved, with the text
 * edited, and with the quoted sentence removed. That is the same thing as
 * editing the page in devtools, but repeatable.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';

const HIGHLIGHT = '[data-smart-tab-notes-highlight]';
const TOOLBAR = '#smart-tab-notes-selection-toolbar .panel';
const CARD = '#smart-tab-notes-annotations .card';

const SITES = [
  'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)',
  'https://arxiv.org/abs/1706.03762',
  'https://developer.mozilla.org/en-US/docs/Web/API/Selection',
  'https://github.com/mozilla/readability',
  // Stack Overflow answers an automated browser with HTTP 403, so the fifth
  // site is one that does not: see the results in the README.
  'https://docs.python.org/3/tutorial/classes.html',
];

const HEAD = '<title>Anchoring fixture</title><style>body{font-family:serif;max-width:40em}</style>';
const P1 = '<p id="p1">Transformers replaced <a href="/rnn">recurrent networks</a> entirely, '
  + 'and attention is all you need.</p>';
const P3 = '<p id="p3">Sparse attention trades exactness for speed on very long inputs.</p>';

const FIXTURES: Record<string, string> = {
  saved: `${HEAD}<h1>Attention and memory</h1>${P1}`
    + '<p id="p2">The model scales quadratically with sequence length, which is why long '
    + 'documents are expensive.</p>'
    + P3,
  edited: `${HEAD}<h1>Attention and memory</h1>`
    + '<p id="p0">An opening paragraph that was not there before, pushing everything down.</p>'
    + P1
    + '<p id="p2">The model scales quadratically with the sequence length, which is why long '
    + 'documents get expensive.</p>'
    + P3,
  removed: `${HEAD}<h1>Attention and memory</h1>${P1}`
    + '<p id="p2">The model scales quadratically with sequence length, which is why long '
    + 'documents are expensive.</p>'
    + '<p id="p3">This paragraph now discusses the migratory patterns of arctic terns, '
    + 'which is a different subject altogether.</p>',
};

const results: { name: string; ok: boolean; detail: string }[] = [];

function report(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

/**
 * Put the toolbar away. Escape closes its popover first and the toolbar
 * second, so this presses until it is gone -- otherwise the next selection
 * reuses a toolbar that is still showing the previous one.
 */
async function dismiss(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4 && await page.locator(TOOLBAR).isVisible(); attempt += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

/** Select an element's text the way a user's drag would. */
async function select(page: Page, selector: string): Promise<string> {
  await dismiss(page);
  const element = page.locator(selector).first();
  await element.scrollIntoViewIfNeeded();
  const text = await element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
  await page.locator(TOOLBAR).waitFor({ state: 'visible', timeout: 10_000 });
  return text;
}

async function highlight(page: Page, selector: string): Promise<string> {
  const text = await select(page, selector);
  await page.locator(TOOLBAR).getByRole('button', { name: 'Highlight', exact: true }).click();
  // A saved highlight draws itself and opens its card; a refusal keeps the
  // toolbar up with the reason in it.
  await page.locator(CARD).waitFor({ state: 'visible', timeout: 20_000 });
  await page.keyboard.press('Escape');
  await dismiss(page);
  return text;
}

/**
 * The notes drawn on the page: one entry per note, in page order, with all
 * of its spans joined. A sentence with a link in it is three spans, so
 * counting spans would say nothing useful.
 */
async function drawnNotes(page: Page): Promise<{ id: string; text: string }[]> {
  return await page.locator(HIGHLIGHT).evaluateAll((spans) => {
    const byNote = new Map<string, string>();
    for (const span of spans) {
      const id = span.getAttribute('data-smart-tab-notes-highlight') ?? '';
      byNote.set(id, (byNote.get(id) ?? '') + (span.textContent ?? ''));
    }
    return [...byNote].map(([id, text]) => ({ id, text: text.replace(/\s+/g, ' ').trim() }));
  });
}

async function drawn(page: Page): Promise<string[]> {
  return (await drawnNotes(page)).map((note) => note.text);
}

/** The first span of one note: the handle to hover or click. */
function spanOf(page: Page, id: string): ReturnType<Page['locator']> {
  return page.locator(`[data-smart-tab-notes-highlight="${id}"]`).first();
}

/** Close the note card, so it cannot sit on top of what we click next. */
async function closeCard(page: Page): Promise<void> {
  if (await page.locator(CARD).isVisible()) {
    await page.keyboard.press('Escape');
    await page.locator(CARD).waitFor({ state: 'hidden', timeout: 5_000 });
  }
}

/**
 * Our own service worker. A browser profile runs several extensions'
 * workers, several of them called background.js, so pick ours by name.
 */
async function ourWorker(context: BrowserContext): Promise<Worker> {
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

/** Read the extension's database from the worker that owns it, oldest first. */
async function storedNotes(
  worker: Worker,
): Promise<{ text: string; orphaned?: boolean; createdAt: number }[]> {
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
        .map((row) => ({ text: row.text, orphaned: row.orphaned, createdAt: row.createdAt }));
    } finally {
      database.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * The fixture: save, reload, edit, remove
 * ------------------------------------------------------------------ */

async function checkFixture(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  let version: keyof typeof FIXTURES = 'saved';
  await page.route('https://anchor.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: FIXTURES[version] }));
  await page.goto('https://anchor.test/');
  await page.locator('#smart-tab-notes-annotations').waitFor({ state: 'attached' });

  const text = await page.locator('body').innerText();
  const quotes = [await highlight(page, '#p1'), await highlight(page, '#p2'), await highlight(page, '#p3')];
  report(
    'fixture: three highlights drawn on save, page text untouched',
    (await drawn(page)).join('|') === quotes.join('|') && (await page.locator('body').innerText()) === text,
    `drawn ${(await drawn(page)).length}/3, link intact: ${await page.locator('#p1 a').count() === 1}`,
  );

  await page.reload();
  await page.locator(HIGHLIGHT).first().waitFor({ timeout: 15_000 });
  const reloaded = await drawn(page);
  report(
    'fixture: all three come back after a reload',
    reloaded.join('|') === quotes.join('|'),
    reloaded.length === 3 ? 'identical quotes' : `got ${reloaded.length}: ${reloaded.join(' / ')}`,
  );

  const card = page.locator(CARD);
  const second = (await drawnNotes(page))[1]!;
  await spanOf(page, second.id).hover();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  const shown = (await card.textContent()) ?? '';
  report(
    'fixture: hovering a highlight opens its note card',
    shown.includes(second.text.slice(0, 40))
      && shown.includes('No AI explanation saved for this highlight yet.'),
    'the card shows the quote, the note and the explanation slot',
  );

  // Add a note from the card, then prove the edit went to storage.
  await closeCard(page);
  await spanOf(page, second.id).click();
  await card.getByRole('button', { name: 'Add note' }).click();
  await card.getByLabel('Note about this text').fill('Why squared?');
  await card.getByRole('button', { name: 'Save note' }).click();
  await card.getByText('Why squared?').waitFor({ timeout: 10_000 });
  await closeCard(page);

  await page.reload();
  await page.locator(HIGHLIGHT).first().waitFor({ timeout: 15_000 });
  await spanOf(page, (await drawnNotes(page))[1]!.id).hover();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  report(
    'fixture: a note edited in the card survives a reload',
    ((await card.textContent()) ?? '').includes('Why squared?'),
    'the edit went to storage, not just to the card',
  );
  await closeCard(page);

  version = 'edited';
  await page.reload();
  await page.locator(HIGHLIGHT).first().waitFor({ timeout: 15_000 });
  const afterEdit = await drawn(page);
  const fuzzy = afterEdit.find((entry) => entry.includes('with the sequence length'));
  report(
    'fixture: a reworded sentence is re-found by fuzzy matching',
    afterEdit.length === 3 && fuzzy !== undefined && afterEdit[0] === quotes[0],
    fuzzy ? `matched: ${fuzzy}` : `only got: ${afterEdit.join(' / ')}`,
  );
  await spanOf(page, (await drawnNotes(page))[1]!.id).hover();
  await page.locator(CARD).waitFor({ state: 'visible', timeout: 10_000 });
  report(
    'fixture: the card says the page changed under an approximate match',
    ((await page.locator(CARD).textContent()) ?? '').includes('The page has changed here'),
    'approximate matches are labelled, not passed off as exact',
  );
  await closeCard(page);

  // Editing the live DOM, as devtools does.
  await page.locator('#p3').evaluate((node) => {
    node.textContent = 'Sparse attention trades exactness for raw speed on extremely long inputs.';
  });
  let redrawn: string[] = [];
  for (let attempt = 0; attempt < 20 && !redrawn.some((entry) => entry.includes('raw speed')); attempt += 1) {
    await page.waitForTimeout(500);
    redrawn = await drawn(page);
  }
  report(
    'fixture: editing the text in the live page redraws the highlight',
    redrawn.some((entry) => entry.includes('raw speed')),
    redrawn.find((entry) => entry.includes('Sparse attention')) ?? `got: ${redrawn.join(' / ')}`,
  );

  version = 'removed';
  await page.reload();
  await page.locator(HIGHLIGHT).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(4_000); // let the orphan attempts run out
  const afterRemoval = await drawn(page);
  const stored = await storedNotes(await ourWorker(context));
  const orphans = stored.filter((note) => note.orphaned === true);
  report(
    'fixture: a quote that is gone orphans its note instead of losing it',
    afterRemoval.length === 2 && stored.length === 3 && orphans.length === 1
      && orphans[0]!.text.startsWith('Sparse attention'),
    `drawn ${afterRemoval.length}, stored ${stored.length}, orphaned ${orphans.length}`,
  );

  // Deleting from the card: the highlight goes, and stays gone.
  const kept = await drawnNotes(page);
  await closeCard(page);
  await spanOf(page, kept[0]!.id).click();
  await card.getByRole('button', { name: 'Delete' }).click();
  await spanOf(page, kept[0]!.id).waitFor({ state: 'detached', timeout: 10_000 });
  await page.reload();
  await page.locator(HIGHLIGHT).first().waitFor({ timeout: 15_000 });
  const afterDelete = await drawn(page);
  const keptNotes = await storedNotes(await ourWorker(context));
  report(
    'fixture: deleting a note takes its highlight away for good',
    afterDelete.length === 1 && keptNotes.length === 2,
    `drawn ${afterDelete.length}, stored ${keptNotes.length}`,
  );

  report('fixture: no page errors', errors.length === 0, errors.join('; ') || 'none');
  await page.close();
}

/* ------------------------------------------------------------------ *
 * Real sites
 * ------------------------------------------------------------------ */

async function checkSite(context: BrowserContext, url: string): Promise<void> {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (response && !response.ok()) throw new Error(`HTTP ${response.status()}`);
    await page.locator('#smart-tab-notes-annotations').waitFor({ state: 'attached', timeout: 20_000 });
    // Sites that render their article client-side replace the text we would
    // otherwise have selected, so let the page settle first.
    await page.waitForLoadState('load').catch(() => undefined);
    await page.waitForTimeout(2_000);

    // Pick the longest block of prose and select it in one step: a separate
    // locator would go stale on a page that is still re-rendering. Sites that
    // rehydrate after load can still drop the selection, so try a few times.
    let quote: string | null = null;
    for (let attempt = 0; attempt < 3 && quote === null; attempt += 1) {
      if (attempt > 0) await page.waitForTimeout(2_000);
      quote = await page.evaluate(() => {
        const blocks = [...document.querySelectorAll('p, blockquote, li, dd')]
          .filter((element) => {
            // innerText, not textContent: a Wikipedia citation carries a
            // stylesheet and a screen-reader label inside the <li>, and
            // neither is prose a reader could choose to highlight.
            const text = (element as HTMLElement).innerText?.trim() ?? '';
            return text.length > 120
              && element.getClientRects().length > 0
              && element.querySelector('p, blockquote, li, dd, style, link') === null
              // The toolbar refuses selections in or around editable controls,
              // and MathML's LaTeX source is not text a reader can see.
              && element.querySelector('input, textarea, select, [contenteditable], math') === null
              && element.closest('input, textarea, select, [contenteditable]') === null;
          })
          .sort((a, b) =>
            ((b as HTMLElement).innerText?.length ?? 0) - ((a as HTMLElement).innerText?.length ?? 0));
        const chosen = blocks[0];
        if (!chosen) return null;

        // The toolbar only shows for a selection inside the viewport.
        chosen.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.selectNodeContents(chosen);
        const selection = window.getSelection();
        if (!selection) return null;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return ((chosen as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
      });
      if (quote === null) continue;
      const appeared = await page.locator(TOOLBAR)
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true, () => false);
      if (!appeared) quote = null; // the page replaced the text; select again
    }
    if (quote === null) throw new Error('could not select a block of prose and keep it');
    await page.locator(TOOLBAR).getByRole('button', { name: 'Highlight', exact: true }).click();
    try {
      await page.locator(CARD).waitFor({ state: 'visible', timeout: 20_000 });
    } catch {
      // The toolbar keeps a refusal; saying what it was beats a bare timeout.
      const toolbar = (await page.locator(TOOLBAR).innerText().catch(() => '')) ?? '';
      const spans = await page.locator(HIGHLIGHT).count();
      throw new Error(`no card after saving (spans: ${spans}, toolbar: ${toolbar.replace(/\s+/g, ' ')})`);
    }
    await closeCard(page);

    // What the extension stored is the baseline for what should come back:
    // its quote comes from the page's normalized text, which is not quite
    // innerText (arXiv's "Abstract:" label is one such difference).
    const saved = (await storedNotes(await ourWorker(context))).at(-1)?.text ?? '';

    await page.reload({ waitUntil: 'domcontentloaded' });
    // Attached, not visible: a quote can begin inside something the page
    // keeps hidden, and the highlight is still correctly placed.
    await page.locator(HIGHLIGHT).first().waitFor({ state: 'attached', timeout: 25_000 });
    const back = await drawn(page);
    const exact = back.length === 1 && back[0] === saved.replace(/\s+/g, ' ').trim();
    report(
      `site: ${new URL(url).host}`,
      exact,
      back.length === 0
        ? `nothing came back (saved: ${saved.slice(0, 60)}...)`
        : `${exact ? 'the saved quote, identical' : 'different text'}: ${back[0]?.slice(0, 70)}...`,
    );
    if (!exact && back.length > 0) console.log(`      saved was: ${saved.slice(0, 70)}...`);
  } catch (error) {
    report(`site: ${new URL(url).host}`, false, error instanceof Error ? error.message : String(error));
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const urls = argv.filter((argument) => argument.startsWith('http'));
const sites = urls.length > 0 ? urls : argv.includes('--sites') ? SITES : [];

const profile = await mkdtemp(resolve(tmpdir(), 'smart-tab-notes-anchors-'));
const extension = resolve('dist');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  // Playwright's own default args include --disable-extensions, which
  // silently cancels --load-extension and leaves a browser with no
  // extension and no error to show for it.
  ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  await checkFixture(context);
  for (const url of sites) await checkSite(context, url);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
