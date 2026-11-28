/**
 * The recap in the real extension: save notes, close the tab, open the page
 * again, and the page offers a recap of what you learned there.
 *
 * This is the demo for ticket #12, run end to end against the mock backend:
 * the popup in the corner, the side panel's Notes view, POST /recap, and the
 * offer being made once per page per browser session.
 */
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// @ts-expect-error -- plain JS helper, no type declarations
import { startMockBackend } from '../../scripts/mock-backend.mjs';

const TOOLBAR = '#smart-tab-notes-selection-toolbar .panel';
const CARD = '#smart-tab-notes-annotations .card';
const POPUP = '#smart-tab-notes-recap .popup';

const PAGE =
  '<title>Recap fixture</title>' +
  '<style>body{margin:0;font-family:serif;max-width:40em}</style>' +
  '<h1>Attention and memory</h1>' +
  '<p id="p1">Transformers replaced recurrent networks entirely.</p>' +
  '<p id="p2">The model scales quadratically with sequence length.</p>';

let context: BrowserContext;
let profile: string;
let backend: { url: string; close: () => Promise<void>; requests: { path: string; body: Record<string, unknown> }[] };
let extensionId: string;

test.beforeAll(async () => {
  backend = await startMockBackend({ port: 0, delayMs: 100 });
  profile = await mkdtemp(resolve(tmpdir(), 'smart-tab-notes-recap-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.PW_CHANNEL ?? 'chromium', headless: true,
    // Playwright's default args include --disable-extensions, which cancels
    // --load-extension and leaves a browser with no extension in it.
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  type Runtime = { chrome?: { runtime?: { getManifest?: () => { name: string } }; storage?: unknown } };
  const isOurs = (candidate: Worker) => candidate.evaluate(() => {
    const api = (globalThis as Runtime).chrome;
    return api?.runtime?.getManifest?.().name === 'Smart Tab Notes' && typeof api.storage === 'object';
  }).catch(() => false);
  let worker: Worker | undefined;
  await expect.poll(async () => {
    for (const candidate of context.serviceWorkers()) if (await isOurs(candidate)) worker = candidate;
    return worker !== undefined;
  }, { timeout: 15_000 }).toBe(true);
  if (!worker) throw new Error('Smart Tab Notes service worker not found');
  extensionId = new URL(worker.url()).host;
  // Point the extension at the mock instead of http://localhost:8000.
  type Storage = { chrome: { storage: { local: { set: (items: object) => Promise<void> } } } };
  await worker.evaluate(
    url => (globalThis as unknown as Storage).chrome.storage.local.set({ apiBaseUrl: url }),
    backend.url,
  );
});

test.afterAll(async () => {
  await context?.close();
  await backend?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

/** The fixture page, served from a route so it can be closed and opened again. */
async function openFixture(): Promise<Page> {
  const page = await context.newPage();
  await page.route('https://recap.test/**', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('https://recap.test/paper');
  await expect(page.locator('#smart-tab-notes-recap')).toHaveCount(1);
  return page;
}

/** Save a note on one paragraph, the way a reader does: select, Note, type. */
async function addNote(page: Page, selector: string, note: string): Promise<void> {
  const element = page.locator(selector).first();
  await element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator(TOOLBAR)).toBeVisible();
  await page.locator(TOOLBAR).getByRole('button', { name: 'Note', exact: true }).click();
  const card = page.locator(CARD);
  await card.getByLabel('Note about this text').fill(note);
  await card.getByRole('button', { name: 'Save note' }).click();
  await expect(card).toContainText(note);
  await page.keyboard.press('Escape');
  await expect(page.locator(CARD)).toBeHidden();
  for (let attempt = 0; attempt < 4 && await page.locator(TOOLBAR).isVisible(); attempt += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
}

test('offers a recap when you come back, and shows it in the side panel', async () => {
  const first = await openFixture();
  const errors: string[] = [];
  first.on('pageerror', error => errors.push(error.message));

  // Nothing is saved yet, so nothing is offered.
  await expect(first.locator(POPUP)).toBeHidden();
  await addNote(first, '#p1', 'the bit I keep forgetting');
  await addNote(first, '#p2', 'why long documents cost so much');
  // Saving a note does not pop the question on the page you are reading.
  await expect(first.locator(POPUP)).toBeHidden();

  // Close the tab, and open the same page again.
  await first.close();
  const again = await openFixture();
  const popup = again.locator(POPUP);
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('You have 2 notes here.');
  await expect(popup).toContainText('See what you learned?');
  // No recap is built until it is asked for.
  expect(backend.requests.filter(request => request.path === '/recap')).toHaveLength(0);

  // The side panel page, opened as a tab, follows the active tab in its window.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await again.bringToFront();

  // Notes offers the recap too, for a reader who never saw the popup.
  await panel.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'What you learned here' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'See what you learned' })).toBeVisible();
  await again.bringToFront();

  await again.locator(`${POPUP} [data-recap-open]`).click();
  // The popup's work is done; the recap is the side panel's.
  await expect(popup).toBeHidden();
  await expect(panel.getByRole('heading', { name: 'What you learned here' })).toBeVisible();
  await expect(panel.locator('.recap__summary')).toContainText('Mock recap of "Recap fixture"');
  await expect(panel.locator('.recap__summary')).toContainText('you saved 2 notes here');
  await expect(panel.locator('.recap__points li')).toHaveCount(2);
  await expect(panel.locator('.recap__points')).toContainText('the bit I keep forgetting');
  await expect(panel.locator('.note__meta')).toContainText('From 2 notes');

  // The backend was given the notes, not the page.
  const sent = backend.requests.filter(request => request.path === '/recap');
  expect(sent).toHaveLength(1);
  const body = sent[0]!.body as { title: string; notes: { text: string; note: string }[] };
  expect(body.title).toBe('Recap fixture');
  expect(body.notes.map(note => note.note)).toEqual([
    'the bit I keep forgetting', 'why long documents cost so much',
  ]);
  expect(body.notes[0]!.text).toContain('Transformers replaced recurrent networks');

  // Leaving Notes and coming back shows the same recap, from the worker's
  // cache: no second call for notes that have not changed.
  await panel.getByRole('button', { name: 'Chat' }).click();
  await panel.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(panel.locator('.recap__summary')).toContainText('Mock recap of');
  expect(backend.requests.filter(request => request.path === '/recap')).toHaveLength(1);

  // "Build it again" asks for a new one, cache or no cache.
  await panel.getByRole('button', { name: 'Build it again' }).click();
  await expect.poll(() => backend.requests.filter(request => request.path === '/recap').length).toBe(2);

  // The offer is made once per page per session: not on a reload.
  await again.reload();
  await expect(again.locator('#smart-tab-notes-recap')).toHaveCount(1);
  await again.waitForTimeout(1_500);
  await expect(again.locator(POPUP)).toBeHidden();

  expect(errors).toEqual([]);
  await Promise.all([again.close(), panel.close()]);
});

test('a page with nothing saved on it is never asked about', async () => {
  const page = await context.newPage();
  await page.route('https://quiet.test/**', route => route.fulfill({
    contentType: 'text/html', body: '<title>Quiet</title><p id="p1">Never annotated.</p>',
  }));
  await page.goto('https://quiet.test/');
  await expect(page.locator('#smart-tab-notes-recap')).toHaveCount(1);
  await page.waitForTimeout(1_500);
  await expect(page.locator(POPUP)).toBeHidden();

  // And the side panel offers no recap for it either.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Notes on this page' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'What you learned here' })).toHaveCount(0);

  await Promise.all([page.close(), panel.close()]);
});
