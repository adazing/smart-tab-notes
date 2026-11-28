/**
 * The recap demo, in the real extension:
 *
 *   npm run test:recap      build first; this checks the dist/ you have
 *
 * Save two notes on a page, close the tab, open the page again, take up the
 * offer in the corner, and read the recap in the side panel.
 *
 * This drives Chromium with dist/ loaded as an unpacked extension, exactly
 * as `npm run test:browser` does, and against the same mock backend. It
 * exists alongside tests/browser/recap.spec.ts because the Playwright
 * *runner* needs Node 20.19+, while this script only needs the library, so
 * the demo still runs on Node 20.17 -- the same reason scripts/anchor-check.ts
 * exists beside tests/browser/anchoring.spec.ts.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { startMockBackend } from './mock-backend.mjs';

const TOOLBAR = '#smart-tab-notes-selection-toolbar .panel';
const CARD = '#smart-tab-notes-annotations .card';
const POPUP = '#smart-tab-notes-recap .popup';

const PAGE =
  '<title>Recap fixture</title>' +
  '<style>body{margin:0;font-family:serif;max-width:40em}</style>' +
  '<h1>Attention and memory</h1>' +
  '<p id="p1">Transformers replaced recurrent networks entirely.</p>' +
  '<p id="p2">The model scales quadratically with sequence length.</p>';

const URL_UNDER_TEST = 'https://recap.test/paper';

interface MockBackend {
  url: string;
  close: () => Promise<void>;
  requests: { method: string; path: string; body: Record<string, unknown> }[];
}

const results: { name: string; ok: boolean; detail: string }[] = [];

function report(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
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
          const api = (globalThis as { chrome?: { runtime?: { getManifest(): { name: string } } } }).chrome;
          return api?.runtime?.getManifest().name ?? null;
        })
        .catch(() => null);
      if (name === 'Smart Tab Notes') return worker;
    }
    await context.waitForEvent('serviceworker', { timeout: 5_000 }).catch(() => undefined);
  }
  throw new Error('the extension service worker never started');
}

/** Put the toolbar away: a toolbar still up would act on the old selection. */
async function dismiss(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4 && await page.locator(TOOLBAR).isVisible(); attempt += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

/** The fixture page, served from a route so it can be closed and opened again. */
async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.route('https://recap.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto(URL_UNDER_TEST, { waitUntil: 'domcontentloaded' });
  await page.locator('#smart-tab-notes-recap').waitFor({ state: 'attached', timeout: 20_000 });
  return page;
}

/** Save a note on one paragraph, the way a reader does: select, Note, type. */
async function addNote(page: Page, selector: string, note: string): Promise<void> {
  await dismiss(page);
  const element = page.locator(selector).first();
  await element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.locator(TOOLBAR).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator(TOOLBAR).getByRole('button', { name: 'Note', exact: true }).click();
  const card = page.locator(CARD);
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  await card.getByLabel('Note about this text').fill(note);
  await card.getByRole('button', { name: 'Save note' }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await card.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  await dismiss(page);
}

async function text(page: Page, selector: string): Promise<string> {
  return ((await page.locator(selector).first().innerText().catch(() => '')) ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function run(context: BrowserContext, backend: MockBackend): Promise<void> {
  const worker = await ourWorker(context);
  // Point the extension at the mock instead of http://localhost:8000.
  await worker.evaluate(
    (url) => (globalThis as unknown as {
      chrome: { storage: { local: { set: (items: object) => Promise<void> } } };
    }).chrome.storage.local.set({ apiBaseUrl: url }),
    backend.url,
  );

  /* 1. A first visit, with notes saved on it. */
  const first = await openFixture(context);
  const errors: string[] = [];
  first.on('pageerror', (error) => errors.push(error.message));
  await first.waitForTimeout(1_200);
  report(
    'a page with nothing saved is not asked about',
    !(await first.locator(POPUP).isVisible()),
    'no popup on the first visit',
  );

  await addNote(first, '#p1', 'the bit I keep forgetting');
  await addNote(first, '#p2', 'why long documents cost so much');
  await first.waitForTimeout(800);
  report(
    'saving a note does not pop the question',
    !(await first.locator(POPUP).isVisible()),
    'no popup while reading the page you are annotating',
  );

  /* 2. Close the tab and open the same page again. */
  await first.close();
  const again = await openFixture(context);
  const popupErrors: string[] = [];
  again.on('pageerror', (error) => popupErrors.push(error.message));
  let popupText = '';
  try {
    await again.locator(POPUP).waitFor({ state: 'visible', timeout: 15_000 });
    popupText = await text(again, POPUP);
  } catch (error) {
    popupText = `never appeared (${error instanceof Error ? error.message : String(error)})`;
  }
  report(
    'reopening the page offers a recap',
    popupText.includes('You have 2 notes here.') && popupText.includes('See what you learned?'),
    popupText,
  );
  report(
    'nothing is sent to the backend until the offer is taken up',
    backend.requests.filter((request) => request.path === '/recap').length === 0,
    `${backend.requests.filter((request) => request.path === '/recap').length} /recap requests so far`,
  );

  /* 3. The side panel, opened as a tab, follows the active tab in its window. */
  const panel = await context.newPage();
  const panelErrors: string[] = [];
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  const extensionId = new URL(worker.url()).host;
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await again.bringToFront();
  await again.waitForTimeout(500);

  // Notes offers the recap too, for a reader who never saw the popup.
  await panel.getByRole('button', { name: 'Notes', exact: true }).click();
  report(
    'the Notes view offers the recap as well',
    await panel.getByRole('button', { name: 'See what you learned' }).isVisible(),
    (await text(panel, '.card')) || '(no card)',
  );
  await again.bringToFront();

  /* 4. Take up the offer. */
  await again.locator(`${POPUP} [data-recap-open]`).click();
  let summary = '';
  let points: string[] = [];
  try {
    await panel.locator('.recap__summary').waitFor({ state: 'visible', timeout: 25_000 });
    summary = await text(panel, '.recap__summary');
    points = (await panel.locator('.recap__points li').allInnerTexts())
      .map((point) => point.replace(/\s+/g, ' ').trim());
  } catch (error) {
    summary = `no recap in the panel (${error instanceof Error ? error.message : String(error)})`;
  }
  report(
    'the side panel shows the recap',
    summary.includes('Mock recap of "Recap fixture"') && summary.includes('you saved 2 notes here'),
    summary,
  );
  report(
    'the recap lists what was marked',
    points.length === 2 && points.some((point) => point.includes('the bit I keep forgetting')),
    points.join(' | ') || '(no points)',
  );
  report(
    'the popup gets out of the way once the panel has it',
    !(await again.locator(POPUP).isVisible()),
    'popup closed',
  );

  const sent = backend.requests.filter((request) => request.path === '/recap');
  const body = sent[0]?.body as { title?: string; notes?: { text: string; note?: string }[] } | undefined;
  const notes = body?.notes ?? [];
  report(
    'the backend was given the notes, with the page title',
    sent.length === 1 &&
      body?.title === 'Recap fixture' &&
      notes.length === 2 &&
      notes[0]?.note === 'the bit I keep forgetting' &&
      (notes[0]?.text ?? '').includes('Transformers replaced recurrent networks'),
    `${sent.length} request(s); notes: ${notes.map((note) => note.note ?? '(no note)').join(' | ')}`,
  );

  /* 5. The recap is cached until the notes change. Leaving Notes and coming
   *    back shows it again, from the cache, without another backend call. */
  await panel.getByRole('button', { name: 'Chat' }).click();
  await panel.getByRole('button', { name: 'Notes', exact: true }).click();
  await panel.locator('.recap__summary').waitFor({ state: 'visible', timeout: 15_000 });
  report(
    'coming back to Notes reuses the recap',
    backend.requests.filter((request) => request.path === '/recap').length === 1,
    `${backend.requests.filter((request) => request.path === '/recap').length} /recap request(s) after a second ask`,
  );

  await panel.getByRole('button', { name: 'Build it again' }).click();
  await panel.waitForTimeout(2_000);
  report(
    '"Build it again" builds a new one',
    backend.requests.filter((request) => request.path === '/recap').length === 2,
    `${backend.requests.filter((request) => request.path === '/recap').length} /recap request(s) after Build it again`,
  );

  /* 6. The offer is made once per page per browser session. */
  await again.reload({ waitUntil: 'domcontentloaded' });
  await again.locator('#smart-tab-notes-recap').waitFor({ state: 'attached', timeout: 20_000 });
  await again.waitForTimeout(1_500);
  report(
    'the offer is not made twice in one session',
    !(await again.locator(POPUP).isVisible()),
    'no popup after a reload',
  );

  report(
    'no page or panel errors',
    errors.length === 0 && popupErrors.length === 0 && panelErrors.length === 0,
    [...errors, ...popupErrors, ...panelErrors].join(' | ') || 'none',
  );

  await Promise.all([again.close(), panel.close()]);
}

/* ------------------------------------------------------------------ */

const backend = (await startMockBackend({ port: 0, delayMs: 100 })) as MockBackend;
const profile = await mkdtemp(resolve(tmpdir(), 'smart-tab-notes-recap-'));
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
  await run(context, backend);
} catch (error) {
  report('the demo ran', false, error instanceof Error ? error.message : String(error));
} finally {
  await context.close();
  await backend.close();
  await rm(profile, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
