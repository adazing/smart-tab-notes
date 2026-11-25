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
  backend = await startMockBackend({ port: 0 });
  profile = await mkdtemp(resolve(tmpdir(), 'smart-tab-notes-chat-'));
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    // PW_CHANNEL=msedge runs these in Microsoft Edge instead.
    channel: process.env.PW_CHANNEL ?? 'chromium', headless: true,
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
  type Storage = { chrome: { storage: { local: { set: (items: object) => Promise<void> } } } };
  await worker.evaluate(url => (globalThis as unknown as Storage).chrome.storage.local.set({ apiBaseUrl: url }), backend.url);
});
test.afterAll(async () => {
  await backend?.close();
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function article(host: string, title: string, text: string): Promise<Page> {
  const page = await context.newPage();
  await page.route(`https://${host}/**`, route => route.fulfill({
    contentType: 'text/html',
    body: `<title>${title}</title><article><h1>${title}</h1><h2>Overview</h2><p>${text}</p></article>`,
  }));
  await page.goto(`https://${host}/`);
  return page;
}

test('asks a question over two tabs, with suggestions and citation chips', async () => {
  const backprop = await article('backprop.test', 'Backpropagation',
    'Backpropagation computes the gradient of the loss for every weight using the chain rule, layer by layer.');
  const descent = await article('descent.test', 'Gradient descent',
    'Gradient descent uses the gradient to nudge each weight downhill so the loss shrinks.');
  const unrelated = await article('cats.test', 'Cat care', 'Cats like warm places and regular meals.');

  // The side panel page, opened as a tab, follows the active tab in its window.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await backprop.bringToFront();

  // The tabs a question uses are tags above the input; the current tab is one by default.
  const using = panel.getByRole('group', { name: 'Tabs this question uses' });
  await expect(using.locator('.tab-tag')).toHaveCount(1);
  await expect(using.locator('.tab-tag')).toContainText('Backpropagation');
  await expect(using.locator('.tab-tag')).toContainText('this tab');

  // Typing ranks the other tabs by title; a suggestion is only used once clicked.
  const input = panel.getByLabel('Question', { exact: true });
  await input.fill('How does gradient descent use the gradient?');
  const suggested = panel.getByRole('group', { name: 'Suggested tabs' });
  await expect(suggested.getByRole('button', { name: '+ Gradient descent' })).toBeVisible();
  await expect(suggested.getByRole('button', { name: /Cat care/ })).toHaveCount(0);
  const rank = backend.requests.filter(r => r.path === '/rank-tabs').at(-1)!.body;
  expect(JSON.stringify(rank)).not.toContain('nudge'); // titles and URLs only, no page text
  await expect(using.locator('.tab-tag')).toHaveCount(1);
  await suggested.getByRole('button', { name: '+ Gradient descent' }).click();
  await expect(using.locator('.tab-tag')).toHaveCount(2);
  await expect(suggested).toBeHidden();

  // "+ Add tab" lists the rest; removing a tag takes it back out.
  await using.getByRole('button', { name: '+ Add tab' }).click();
  await panel.getByRole('list', { name: 'Other tabs in this window' }).getByRole('button', { name: /Cat care/ }).click();
  await expect(using.locator('.tab-tag')).toHaveCount(3);
  await using.getByRole('button', { name: "Don't use Cat care" }).click();
  await expect(using.locator('.tab-tag')).toHaveCount(2);

  await input.press('Enter');
  await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
  const turn = panel.locator('.turn').last();
  await expect(turn.locator('.turn__question')).toHaveText('How does gradient descent use the gradient?');
  await expect(turn.locator('.answer__text')).toContainText('Mock answer to');
  await expect(turn.locator('.answer__text .chip')).toHaveCount(2);
  await expect(turn.getByRole('list', { name: 'Sources' }).getByRole('button')).toHaveCount(2);
  // Raw markers never show.
  await expect(turn.locator('.answer__text')).not.toContainText('[t');

  const sent = backend.requests.filter(r => r.path === '/chat').at(-1)!.body as { tabs: { title: string }[] };
  expect(sent.tabs.map(t => t.title)).toEqual(['Backpropagation', 'Gradient descent']);

  // Clicking a chip switches to the cited tab.
  await turn.getByRole('button', { name: /Source \d: Gradient descent/ }).click();
  await expect.poll(() => descent.evaluate(() => document.visibilityState)).toBe('visible');

  // A follow-up carries the history.
  await backprop.bringToFront();
  await input.fill('And the chain rule?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.turn')).toHaveCount(2);
  await expect(panel.locator('.turn').last().locator('.answer__text')).toContainText('Mock answer to "And the chain rule?"');
  const followUp = backend.requests.filter(r => r.path === '/chat').at(-1)!.body as { messages: { role: string }[] };
  expect(followUp.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);

  // An error event is shown, with a retry. (Wait for the answer to finish: Send is Stop while streaming.)
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 30_000 });
  await input.fill('Please fail now');
  await input.press('Enter');
  await expect(panel.getByRole('alert')).toContainText('The chat service failed');
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();

  // The conversation survives switching views.
  await panel.getByRole('button', { name: 'Notes', exact: true }).click();
  await panel.getByRole('button', { name: 'Chat' }).click();
  await expect(panel.locator('.turn')).toHaveCount(3);

  await Promise.all([backprop.close(), descent.close(), unrelated.close(), panel.close()]);
});

test('says when the backend is unreachable', async () => {
  const page = await article('offline.test', 'Offline', 'Some text to ask about.');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.bringToFront();
  const worker = context.serviceWorkers().find(w => new URL(w.url()).host === extensionId)!;
  type Storage = { chrome: { storage: { local: { set: (items: object) => Promise<void> } } } };
  await worker.evaluate(() => (globalThis as unknown as Storage).chrome.storage.local.set({ apiBaseUrl: 'http://127.0.0.1:9' }));
  try {
    await panel.getByLabel('Question', { exact: true }).fill('What is this?');
    await panel.getByLabel('Question', { exact: true }).press('Enter');
    await expect(panel.getByRole('alert')).toContainText("Can't reach the Smart Tab Notes server");
  } finally {
    await worker.evaluate(url => (globalThis as unknown as Storage).chrome.storage.local.set({ apiBaseUrl: url }), backend.url);
    await Promise.all([page.close(), panel.close()]);
  }
});
