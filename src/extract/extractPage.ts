/**
 * Readable-text extraction for one page.
 *
 * This file is bundled on its own into dist/extract.js and injected into a
 * tab with chrome.scripting (see shared/tabContext.ts). It never runs on its
 * own: pages are only read when getTabContext is called for them.
 *
 * Strategy:
 *   1. Run Mozilla Readability on a copy of the document (it mutates what it
 *      is given) and turn the article HTML into ordered heading/text blocks.
 *   2. If Readability finds no article, or one under MIN_ARTICLE_WORDS, fall
 *      back to the page's visible text, skipping nav, footers, forms and
 *      hidden elements.
 */

import { Readability } from '@mozilla/readability';
import type { ExtractedPage, TextBlock } from '../shared/types';

export interface ExtractOptions {
  /** Cap on total text length, so a huge page cannot flood a message. Default 200,000. */
  maxChars?: number;
}

const MIN_ARTICLE_WORDS = 50;
const DEFAULT_MAX_CHARS = 200_000;

const HEADING = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
/** Blocks whose whole text content is one unit; we do not look inside them. */
const LEAF_BLOCK = new Set([
  'P', 'LI', 'PRE', 'BLOCKQUOTE', 'DT', 'DD', 'FIGCAPTION', 'TD', 'TH', 'CAPTION', 'SUMMARY',
]);
/** Inline elements whose text belongs to the surrounding run of text. */
const INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'KBD', 'MARK',
  'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'BR', 'LABEL',
  'FONT', 'MATH',
]);
/** Never text we want. */
const SKIP_ALWAYS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
  'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'HEAD', 'META', 'LINK', 'INPUT', 'TEXTAREA', 'SELECT',
  'BUTTON',
]);
/** Page chrome, skipped only in the visible-text fallback. */
const SKIP_CHROME = new Set(['NAV', 'FOOTER', 'ASIDE', 'FORM', 'DIALOG', 'MENU']);
const SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog']);

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function collapsePre(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

interface WalkOptions {
  /** Fallback mode: skip page chrome and anything not rendered. */
  visibleOnly: boolean;
}

function isHidden(el: Element): boolean {
  if ((el as HTMLElement).hidden) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  // checkVisibility is Chrome 105+; jsdom has no layout, so skip it there.
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' ? !check.call(el) : false;
}

/** Walk `root` in document order and produce heading/text blocks. */
export function blocksFrom(root: Element, options: WalkOptions): TextBlock[] {
  const blocks: TextBlock[] = [];
  let inline = '';

  const flushInline = (): void => {
    const text = collapse(inline);
    if (text) blocks.push({ kind: 'text', text });
    inline = '';
  };

  const visit = (node: Node): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      inline += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;

    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_ALWAYS.has(tag)) return;
    if (options.visibleOnly) {
      if (SKIP_CHROME.has(tag)) return;
      const role = el.getAttribute('role');
      if (role && SKIP_ROLES.has(role)) return;
      if (isHidden(el)) return;
    }

    if (tag === 'BR') {
      inline += ' ';
      return;
    }
    if (INLINE.has(tag)) {
      el.childNodes.forEach(visit);
      return;
    }
    if (HEADING.has(tag)) {
      flushInline();
      const text = cleanHeading(collapse(el.textContent ?? ''));
      if (text) blocks.push({ kind: 'heading', text, level: Number(tag[1]) });
      return;
    }
    if (LEAF_BLOCK.has(tag)) {
      flushInline();
      const raw = el.textContent ?? '';
      const text = tag === 'PRE' ? collapsePre(raw) : collapse(raw);
      if (text) blocks.push({ kind: 'text', text });
      return;
    }
    // A container (div, section, article, ul, table...): its own text runs
    // are blocks of their own, separate from its children's blocks.
    flushInline();
    el.childNodes.forEach(visit);
    flushInline();
  };

  visit(root);
  flushInline();
  return blocks;
}

function capBlocks(blocks: TextBlock[], maxChars: number): { blocks: TextBlock[]; truncated: boolean } {
  const kept: TextBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    const room = maxChars - used;
    if (room <= 0) return { blocks: kept, truncated: true };
    if (block.text.length > room) {
      kept.push({ ...block, text: block.text.slice(0, room) });
      return { blocks: kept, truncated: true };
    }
    kept.push(block);
    used += block.text.length + 2;
  }
  return { blocks: kept, truncated: false };
}

/** Drop anchor/edit decorations that sites append to headings. */
export function cleanHeading(text: string): string {
  return text.replace(/\s*\[edit\]\s*$/i, '').replace(/[\s¶#§🔗]+$/u, '').trim();
}

/**
 * Readability often throws away section headings (Wikipedia's and Sphinx's
 * headings carry edit/anchor links, which its clutter cleanup dislikes), and
 * those headings are what chunks are labelled with. So keep Readability's
 * choice of body text, but rebuild the headings from the original page: find
 * each kept block in the page's full text and insert the nearest heading
 * above it whenever it changes.
 */
export function restoreHeadings(readable: TextBlock[], source: TextBlock[]): TextBlock[] {
  let sourceText = '';
  const headingsAt: { offset: number; block: TextBlock }[] = [];
  for (const block of source) {
    if (block.kind === 'heading') headingsAt.push({ offset: sourceText.length, block });
    sourceText += block.text + '\n';
  }

  const out: TextBlock[] = [];
  let cursor = 0;
  let headingIndex = -1; // index into headingsAt of the last source heading passed
  let lastHeading = '';
  const emitHeading = (heading: TextBlock): void => {
    if (heading.text === lastHeading) return;
    out.push(heading);
    lastHeading = heading.text;
  };

  for (const block of readable) {
    // Headings Readability kept are still trusted.
    if (block.kind === 'heading') {
      emitHeading(block);
      continue;
    }
    // A short paragraph that is really a page heading plus its "[edit]" link
    // (Readability flattens Wikipedia's heading wrappers in live Chrome pages):
    // treat it as that heading instead of repeating it as text.
    if (block.text.length <= 200) {
      const asHeading = cleanHeading(block.text);
      const next = headingsAt.findIndex((h, i) => i > headingIndex && h.block.text === asHeading);
      if (asHeading && next >= 0) {
        headingIndex = next;
        cursor = headingsAt[next]!.offset;
        emitHeading(headingsAt[next]!.block);
        continue;
      }
    }
    const probe = block.text.slice(0, 60);
    const found = sourceText.indexOf(probe, cursor);
    if (found >= 0) {
      cursor = found;
      let nearest = headingIndex;
      while (nearest + 1 < headingsAt.length && headingsAt[nearest + 1]!.offset <= found) nearest++;
      if (nearest !== headingIndex && nearest >= 0) emitHeading(headingsAt[nearest]!.block);
      headingIndex = nearest;
    }
    out.push(block);
  }
  return out;
}

function fromReadability(doc: Document): { title: string; blocks: TextBlock[] } | null {
  let article: ReturnType<Readability['parse']>;
  try {
    article = new Readability(doc.cloneNode(true) as Document).parse();
  } catch {
    return null;
  }
  if (!article?.content) return null;

  // Parse the article HTML into an inert document: nothing loads or runs.
  const parsed = new DOMParser().parseFromString(article.content, 'text/html');
  const blocks = blocksFrom(parsed.body, { visibleOnly: false });
  const words = blocks.reduce((n, b) => n + countWords(b.text), 0);
  if (words < MIN_ARTICLE_WORDS) return null;
  const source = doc.body ? blocksFrom(doc.body, { visibleOnly: false }) : [];
  return { title: collapse(article.title ?? ''), blocks: restoreHeadings(blocks, source) };
}

/**
 * Stack Overflow and every other Stack Exchange site. Readability treats the
 * top answer as "the article" and drops the question and the other answers,
 * so read the question and each answer body directly, with headings.
 * Comments, votes and sidebars are left out.
 */
export function fromStackExchange(doc: Document): { title: string; blocks: TextBlock[] } | null {
  const question = doc.querySelector('#question');
  if (!question || !doc.querySelector('#answers')) return null;

  const body = (post: Element): Element | null =>
    post.querySelector('.js-post-body, .s-prose, .post-text');
  const questionBody = body(question);
  if (!questionBody) return null;

  const title = collapse(
    doc.querySelector('#question-header h1')?.textContent ?? doc.querySelector('h1')?.textContent ?? '',
  );
  const blocks: TextBlock[] = [];
  if (title) blocks.push({ kind: 'heading', text: title, level: 1 });
  blocks.push({ kind: 'heading', text: 'Question', level: 2 });
  blocks.push(...blocksFrom(questionBody, { visibleOnly: false }));

  doc.querySelectorAll('#answers .answer').forEach((answer, i) => {
    const answerBody = body(answer);
    if (!answerBody) return;
    const accepted =
      answer.classList.contains('accepted-answer') || answer.getAttribute('itemprop') === 'acceptedAnswer';
    blocks.push({ kind: 'heading', text: `Answer ${i + 1}${accepted ? ' (accepted)' : ''}`, level: 2 });
    blocks.push(...blocksFrom(answerBody, { visibleOnly: false }));
  });
  return { title, blocks };
}

export function extractPage(doc: Document = document, options: ExtractOptions = {}): ExtractedPage {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  // Site rules first, then Readability, then the visible-text fallback.
  const site = fromStackExchange(doc);
  const readable = site ? null : fromReadability(doc);
  const extractor: ExtractedPage['extractor'] = site ? 'stack-exchange' : readable ? 'readability' : 'visible-text';
  const rawBlocks =
    site?.blocks ?? readable?.blocks ?? (doc.body ? blocksFrom(doc.body, { visibleOnly: true }) : []);

  const { blocks, truncated } = capBlocks(rawBlocks, maxChars);
  const text = blocks.map((b) => b.text).join('\n\n');

  return {
    title: site?.title || readable?.title || collapse(doc.title ?? ''),
    url: doc.URL,
    text,
    wordCount: countWords(text),
    blocks,
    extractor,
    truncated,
  };
}
