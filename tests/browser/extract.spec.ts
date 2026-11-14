import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The page extractor (dist/extract.js) in real Chromium, for the cases that
 * depend on layout: what counts as hidden. Run `npm run build` first.
 */

const EXTRACT = readFileSync(resolve('dist/extract.js'), 'utf8');
const prose = (topic: string): string =>
  Array.from({ length: 12 }, (_, i) => `Sentence ${i} explains ${topic} so the reader can follow.`).join(' ');

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => browser.close());

async function extract(page: Page, body: string, css = ''): Promise<{ extractor: string; words: number; text: string }> {
  await page.setContent(`<title>T</title><style>${css}</style><body>${body}</body>`);
  await page.addScriptTag({ content: EXTRACT });
  return page.evaluate(() => {
    const api = (globalThis as unknown as { SmartTabNotesExtract: { extractPage: (d: Document) => { extractor: string; wordCount: number; text: string } } }).SmartTabNotesExtract;
    const r = api.extractPage(document);
    return { extractor: r.extractor, words: r.wordCount, text: r.text };
  });
}

test('an article inside a display:contents wrapper is extracted', async () => {
  const page = await browser.newPage();
  const r = await extract(page, `<div style="display:contents"><article><h1>A</h1><p>${prose('topic')}</p><p>${prose('more')}</p></article></div>`);
  expect(r.extractor).toBe('readability');
  expect(r.words).toBeGreaterThan(150);
});

test('hidden headings and stylesheet-hidden text never come through', async () => {
  const page = await browser.newPage();
  const r = await extract(
    page,
    `<article><h1>A</h1><p>${prose('topic')}</p>
      <h2 style="display:none">SECRET_INLINE_HEADING</h2>
      <h3 class="gone">SECRET_STYLESHEET_HEADING</h3>
      <p class="vh">SECRET_VISIBILITY_HIDDEN</p>
      <p>${prose('more')}</p></article>`,
    '.gone{display:none} .vh{visibility:hidden}',
  );
  expect(r.text).not.toContain('SECRET');
});

test('visibility:hidden with a visible child keeps only the child', async () => {
  const page = await browser.newPage();
  const r = await extract(
    page,
    `<article><h1>A</h1><p>${prose('topic')}</p><div class="vh">SECRET_PARENT <p class="vv">Visible child text.</p></div><p>${prose('more')}</p></article>`,
    '.vh{visibility:hidden} .vv{visibility:visible}',
  );
  expect(r.text).toContain('Visible child text.');
  expect(r.text).not.toContain('SECRET_PARENT');
});

test('closed <details> content is kept, but hidden text inside it is not', async () => {
  const page = await browser.newPage();
  const r = await extract(
    page,
    `<article><h1>A</h1><p>${prose('topic')}</p>
      <details><summary>More</summary><p>Folded but real content.</p><p class="h">SECRET_IN_DETAILS</p></details>
      <p>${prose('more')}</p></article>`,
    '.h{display:none}',
  );
  expect(r.text).toContain('Folded but real content.');
  expect(r.text).not.toContain('SECRET');
});

test('the visible-text fallback drops hidden spans, scripts and styles inside blocks', async () => {
  const page = await browser.newPage();
  const r = await extract(
    page,
    `<div><h2>Dashboard</h2><p>Shown <span style="display:none">SECRET_SPAN</span> text.</p>
      <ul><li>Item<script>var SECRET_SCRIPT = 1;</script></li></ul>
      <table><tr><td>Cell<style>.SECRET_STYLE{}</style></td></tr></table>
      <p class="vh">SECRET_VH</p></div>`,
    '.vh{visibility:hidden}',
  );
  expect(r.extractor).toBe('visible-text');
  expect(r.text).toContain('Shown');
  expect(r.text).not.toContain('SECRET');
});
