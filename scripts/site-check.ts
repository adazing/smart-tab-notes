/**
 * Runs the page extractor and chunker against real sites.
 *
 *   npm run test:sites            the default list below
 *   npm run test:sites -- <url>   one or more URLs of your choice
 *
 * Fetches each page's server HTML and runs extractPage in jsdom. That is the
 * same code the extension injects, but jsdom does not run the page's own
 * JavaScript or compute layout, so client-rendered sites look worse here
 * than in Chrome, and hidden-element checks are skipped. Use the side panel's
 * "Extract text" button for the real-Chrome result.
 */

import { JSDOM } from 'jsdom';
import { extractPage } from '../src/extract/extractPage';
import { chunkBlocks } from '../src/shared/chunk';

const DEFAULT_SITES = [
  'https://en.wikipedia.org/wiki/Backpropagation',
  'https://arxiv.org/abs/1706.03762',
  'https://medium.com/@karpathy/software-2-0-a64152b37c35',
  'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
  'https://github.com/mozilla/readability',
  'https://docs.python.org/3/tutorial/classes.html',
  'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
  'https://news.ycombinator.com/',
  'https://react.dev/learn',
  'https://paulgraham.com/greatwork.html',
];

const sites = process.argv.slice(2).filter((arg) => arg.startsWith('http'));

async function check(url: string): Promise<void> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (smart-tab-notes site-check)', Accept: 'text/html' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const dom = new JSDOM(await response.text(), { url: response.url });
  // extractPage parses Readability's output with the global DOMParser.
  (globalThis as { DOMParser?: unknown }).DOMParser = dom.window.DOMParser;

  const page = extractPage(dom.window.document);
  const chunks = chunkBlocks(page.blocks, 1);
  const headings = page.blocks.filter((b) => b.kind === 'heading').length;

  console.log(`\n## ${url}`);
  console.log(
    `extractor=${page.extractor} words=${page.wordCount} blocks=${page.blocks.length} ` +
      `headings=${headings} chunks=${chunks.length}${page.truncated ? ' TRUNCATED' : ''}`,
  );
  console.log(`title: ${page.title}`);
  for (const chunk of chunks.slice(0, 3)) {
    console.log(`  [${chunk.id}] (${chunk.heading || 'no heading'}, ~${chunk.tokenEstimate} tok) ${chunk.text.slice(0, 140).replace(/\n+/g, ' | ')}`);
  }
}

for (const url of sites.length ? sites : DEFAULT_SITES) {
  try {
    await check(url);
  } catch (error) {
    console.log(`\n## ${url}\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}
