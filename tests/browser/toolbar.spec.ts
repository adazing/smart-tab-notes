import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// @ts-expect-error -- plain JS helper, no type declarations
import { startMockBackend } from '../../scripts/mock-backend.mjs';

let context: BrowserContext;
let profile: string;
let backend: { url: string; close: () => Promise<void>; requests: { path: string; body: Record<string, unknown> }[] };
let extensionId: string;
test.beforeAll(async () => {
  backend = await startMockBackend({ port: 0, delayMs: 300 });
  profile = await mkdtemp(resolve(tmpdir(), 'smart-tab-notes-browser-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    // PW_CHANNEL=msedge runs these in Microsoft Edge instead.
    channel: process.env.PW_CHANNEL ?? 'chromium', headless: true,
    // Playwright's default args include --disable-extensions, which cancels
    // --load-extension and leaves a browser with no extension in it.
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // Chromium's own component extensions have service workers too; find ours
  // by name, once its extension APIs are bound.
  type Runtime = { chrome?: { runtime?: { getManifest?: () => { name: string } }; storage?: unknown } };
  const isOurs = (w: Worker) => w.evaluate(() => {
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
  await worker.evaluate(url => (globalThis as unknown as Storage).chrome.storage.local.set({ apiBaseUrl: url }), backend.url);
});
test.afterAll(async () => {
  await context?.close();
  await backend?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function select(page: Page, selector: string): Promise<void> {
  await expect(page.locator('#smart-tab-notes-selection-toolbar')).toHaveCount(1);
  const paragraph = page.locator(selector).filter({ visible: true }).filter({ hasText: /\S/ }).first();
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator('#smart-tab-notes-selection-toolbar .panel')).toBeVisible();
}

test('actual extension: actions, selection snapshots, isolation, edges, and dismissal', async () => {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://toolbar.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<style>body{margin:0;font-family:serif}button,input{display:none!important}p{width:260px}#spacer{height:2000px}</style>
      <p id="text">Selected <a href="/next">formatted link</a> and multiple lines of useful words to explain.</p>
      <p id="other">Different text</p><textarea>Do not show a toolbar here</textarea><div id="spacer"></div>`,
  }));
  await page.goto('https://toolbar.test/');
  await expect(page.locator('#smart-tab-notes-selection-toolbar')).toHaveCount(1);
  // Real mouse drag: toolbar stays hidden during the drag, then appears on release.
  const textBox = await page.locator('#text').boundingBox();
  await page.mouse.move(textBox!.x + 2, textBox!.y + 8);
  await page.mouse.down();
  await page.mouse.move(textBox!.x + 100, textBox!.y + 8, { steps: 8 });
  await expect(page.locator('#smart-tab-notes-selection-toolbar .panel')).toBeHidden();
  await page.mouse.up();
  await expect(page.locator('#smart-tab-notes-selection-toolbar .panel')).toBeVisible();
  await select(page, '#text');
  const panel = page.locator('#smart-tab-notes-selection-toolbar .panel');
  const before = await page.locator('#text').innerHTML();
  for (const name of ['Explain', 'Ask', 'Note']) {
    await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(panel.locator('.actions button')).toHaveCount(3);
  await panel.getByRole('button', { name: 'Explain', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Explaining');
  await expect(panel.locator('.answer')).toContainText('Mock explanation of "Selected format');
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  await panel.getByLabel('Question about this text').fill('What does it mean?');
  // Browser selection can disappear while the editor is focused; action still works.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await panel.getByLabel('Question about this text').press('Enter');
  await expect(panel.locator('.answer')).toContainText('Mock answer to "What does it mean?"');
  // Highlight saves through the annotation layer, which wraps the text in
  // spans and opens the card with its note box ready. Anchoring itself is
  // covered by anchoring.spec.ts; here we only check the hand-over.
  const text = await page.locator('#text').innerText();
  await panel.getByRole('button', { name: 'Note', exact: true }).click();
  const card = page.locator('#smart-tab-notes-annotations .card');
  await expect(card).toBeVisible();
  await expect(page.locator('[data-smart-tab-notes-highlight]').first()).toBeVisible();
  await expect(panel).toBeHidden();
  expect(await page.locator('#text').innerText()).toBe(text);
  expect(await page.locator('#text').innerHTML()).not.toBe(before);
  expect(await page.locator('#text a').getAttribute('href')).toBe('/next');
  await card.getByLabel('Note about this text').fill('A saved note');
  await card.getByRole('button', { name: 'Save note' }).click();
  await expect(card).toContainText('A saved note');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await select(page, '#other');
  await page.mouse.click(500, 200);
  await expect(panel).toBeHidden();
  await select(page, '#text');
  await page.setViewportSize({ width: 240, height: 400 });
  await expect(async () => {
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(240);
  }).toPass();
  await page.mouse.wheel(0, 1200);
  await expect(panel).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await select(page, '#text');
  await page.evaluate(() => history.pushState({}, '', '/new-page'));
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
  await page.close();
});

test('explain, save as a highlight, see it in the side panel, and find it again after closing the tab', async () => {
  const route = (p: Page) => p.route('https://notes.test/**', r => r.fulfill({
    contentType: 'text/html',
    body: `<title>Notes test</title><article><h1 id="heading">Training neural networks</h1>
      <p id="text">Networks are trained with backpropagation and gradient descent.</p></article>`,
  }));
  let page = await context.newPage();
  await route(page);
  const other = await context.newPage();
  await other.route('https://other.test/**', r => r.fulfill({
    contentType: 'text/html',
    body: '<title>Gradient descent</title><article><p>Gradient descent nudges weights downhill to reduce the loss of a model.</p></article>',
  }));
  await other.goto('https://other.test/');
  await page.goto('https://notes.test/article?utm_source=feed');
  await page.bringToFront();

  // Explain, then save the answer: the text is highlighted and its card opens.
  await select(page, '#text');
  const panel = page.locator('#smart-tab-notes-selection-toolbar .panel');
  await panel.getByRole('button', { name: 'Explain', exact: true }).click();
  await expect(panel.locator('.answer')).toContainText('Mock explanation of "Networks are trained');
  const sent = backend.requests.filter(r => r.path === '/explain').at(-1)!.body;
  expect(sent.page_text).toContain('backpropagation and gradient descent');
  expect((sent.other_tabs as { title: string }[]).map(t => t.title)).toContain('Gradient descent');
  await expect(panel.locator('.sources')).toContainText('Gradient descent');
  await panel.getByRole('button', { name: 'Save as note' }).click();
  let card = page.locator('#smart-tab-notes-annotations .card');
  await expect(card).toContainText('Mock explanation of');
  await expect(card.getByRole('link', { name: 'Gradient descent' })).toBeVisible();
  await expect(page.locator('[data-smart-tab-notes-highlight]').first()).toBeVisible();
  await card.getByRole('button', { name: 'Write note' }).click();
  await card.getByLabel('Note about this text').fill('Check the chain rule');
  await card.getByRole('button', { name: 'Save note' }).click();
  await expect(card).toContainText('Check the chain rule');
  await page.keyboard.press('Escape');

  // The side panel lists it; clicking it jumps back to the highlight.
  const sidepanel = await context.newPage();
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.bringToFront();
  await sidepanel.getByRole('button', { name: 'Notes', exact: true }).click();
  const notes = sidepanel.locator('.note');
  await expect(notes).toHaveCount(1);
  await expect(notes.first()).toContainText('Networks are trained with backpropagation');
  await expect(notes.first()).toContainText('Mock explanation of');
  await expect(notes.first()).toContainText('Check the chain rule');
  await expect(sidepanel.getByText('Developer tools')).toBeVisible();
  await expect(sidepanel.getByRole('button', { name: 'Extract text' })).toBeHidden();
  await notes.first().locator('.note__jump').click();
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');

  // Close the tab and open the page again: the highlight comes back.
  await page.close();
  page = await context.newPage();
  await route(page);
  await page.goto('https://notes.test/article');
  await page.bringToFront();
  card = page.locator('#smart-tab-notes-annotations .card');
  await expect(page.locator('[data-smart-tab-notes-highlight]').first()).toBeVisible();
  // Clicking highlighted text shows the note on the page and brings it up in the side panel.
  await sidepanel.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.locator('[data-smart-tab-notes-highlight]').first().click();
  await expect(card).toContainText('Check the chain rule');
  await expect(sidepanel.getByRole('button', { name: 'Notes', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(sidepanel.locator('.note--focused')).toContainText('Networks are trained with backpropagation');
  await page.keyboard.press('Escape');

  // A plain Highlight opens its note box straight away, and shows up live in the panel.
  await select(page, '#heading');
  await page.locator('#smart-tab-notes-selection-toolbar .panel').getByRole('button', { name: 'Note', exact: true }).click();
  await card.getByLabel('Note about this text').fill('Second note');
  await card.getByRole('button', { name: 'Save note' }).click();
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(1)).toContainText('Second note');

  // Editing from the side panel updates the card on the page.
  await notes.nth(1).getByRole('button', { name: 'Edit note' }).click();
  await notes.nth(1).getByLabel('Note', { exact: true }).fill('Second note, edited');
  await notes.nth(1).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notes.nth(1)).toContainText('Second note, edited');
  await page.mouse.move(0, 0);
  await page.locator('#heading [data-smart-tab-notes-highlight]').first().click();
  await expect(card).toContainText('Second note, edited');
  await page.keyboard.press('Escape');

  // Deleting from the side panel takes the highlight off the page too.
  await notes.nth(1).getByRole('button', { name: 'Delete' }).click();
  await notes.nth(1).getByRole('button', { name: 'Really delete?' }).click();
  await expect(notes).toHaveCount(1);
  await expect(page.locator('#heading [data-smart-tab-notes-highlight]')).toHaveCount(0);
  await Promise.all([page.close(), other.close(), sidepanel.close()]);
});

test('a page script cannot trigger Explain by clicking the toolbar', async () => {
  const page = await context.newPage();
  await page.route('https://evil.test/**', route => route.fulfill({
    contentType: 'text/html', body: '<p id="text">Some text on a hostile page.</p>',
  }));
  await page.goto('https://evil.test/');
  await select(page, '#text');
  const before = backend.requests.length;
  await page.evaluate(() => {
    const root = document.querySelector('#smart-tab-notes-selection-toolbar')!.shadowRoot!;
    [...root.querySelectorAll('button')].find(b => b.textContent === 'Explain')!.click();
  });
  await page.waitForTimeout(800);
  expect(backend.requests.length).toBe(before);
  await expect(page.locator('#smart-tab-notes-selection-toolbar .answer')).toHaveCount(0);
  await page.close();
});

// Opt-in: network access and publisher bot restrictions may prevent real-site checks.
const websites = [
  ['Wikipedia', 'https://en.wikipedia.org/wiki/TypeScript', '#mw-content-text p'],
  ['arXiv', 'https://arxiv.org/abs/1706.03762', 'blockquote.abstract'],
  ['Medium', 'https://medium.com/@karpathy/software-2-0-a64152b37c35', 'article p'],
  ['MDN', 'https://developer.mozilla.org/en-US/docs/Web/API/Selection', 'main p'],
  ['GitHub', 'https://github.com/microsoft/TypeScript', 'article p'],
] as const;
for (const [name, url, selector] of websites) {
  test(`live site: ${name}`, async () => {
    test.skip(!process.env.TOOLBAR_LIVE_SITES, 'Set TOOLBAR_LIVE_SITES=1 to check external websites');
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (name === 'Medium' && response?.status() === 403 && (await page.title()).includes('Just a moment')) {
        test.skip(true, 'Medium returned HTTP 403 with a bot challenge; manual testing is required');
      }
      await select(page, selector);
      const panel = page.locator('#smart-tab-notes-selection-toolbar .panel');
      await panel.getByRole('button', { name: 'Explain', exact: true }).click();
      await expect(panel.locator('.answer')).toContainText('Mock explanation');
      await panel.getByRole('button', { name: 'Ask', exact: true }).click();
      await panel.getByLabel('Question about this text').fill('Explain this passage');
      await panel.getByLabel('Question about this text').press('Enter');
      await expect(panel.locator('.answer')).toContainText('Mock answer');
      await panel.getByRole('button', { name: 'Note', exact: true }).click();
      await expect(page.locator('[data-smart-tab-notes-highlight]').first()).toBeVisible();
      await page.locator('#smart-tab-notes-annotations .card').getByLabel('Note about this text').fill('Site test note');
      await page.locator('#smart-tab-notes-annotations .card').getByRole('button', { name: 'Save note' }).click();
      await expect(page.locator('#smart-tab-notes-annotations .card')).toContainText('Site test note');
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    } finally { await page.close(); }
  });
}
