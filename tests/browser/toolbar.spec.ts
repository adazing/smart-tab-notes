import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let context: BrowserContext;
let profile: string;
test.beforeAll(async () => {
  profile = await mkdtemp(resolve(tmpdir(), 'smart-tab-notes-browser-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
});
test.afterAll(async () => {
  await context?.close();
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
  for (const name of ['Explain', 'Ask', 'Highlight', 'Note']) {
    await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await panel.getByRole('button', { name: 'Explain', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Loading explanation');
  await expect(panel.getByRole('status')).toContainText('Mock explanation');
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  await panel.getByLabel('Question about this text').fill('What does it mean?');
  // Browser selection can disappear while the editor is focused; action still works.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await panel.getByLabel('Question about this text').press('Enter');
  await expect(panel.getByRole('status')).toContainText('Demo: question received');
  await panel.getByRole('button', { name: 'Highlight', exact: true }).click();
  await expect(page.locator('#smart-tab-notes-selection-toolbar .highlight').first()).toBeVisible();
  expect(await page.locator('#text').innerHTML()).toBe(before);
  await panel.getByRole('button', { name: 'Note', exact: true }).click();
  await panel.getByLabel('Note about this text').fill('A temporary note');
  await panel.getByRole('button', { name: 'Save temporarily' }).click();
  await expect(panel.getByRole('status')).toContainText('has not been saved to storage');
  await page.keyboard.press('Escape');
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
      await expect(panel.getByRole('status')).toContainText('Mock explanation');
      await panel.getByRole('button', { name: 'Ask', exact: true }).click();
      await panel.getByLabel('Question about this text').fill('Explain this passage');
      await panel.getByLabel('Question about this text').press('Enter');
      await expect(panel.getByRole('status')).toContainText('Demo: question received');
      await panel.getByRole('button', { name: 'Highlight', exact: true }).click();
      await expect(page.locator('#smart-tab-notes-selection-toolbar .highlight').first()).toBeVisible();
      await panel.getByRole('button', { name: 'Note', exact: true }).click();
      await panel.getByLabel('Note about this text').fill('Site test note');
      await panel.getByRole('button', { name: 'Save temporarily' }).click();
      await expect(panel.getByRole('status')).toContainText('has not been saved');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    } finally { await page.close(); }
  });
}
