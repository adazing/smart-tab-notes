// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractPage, restoreHeadings } from './extractPage';

const prose = (topic: string, n = 6): string =>
  Array.from({ length: n }, (_, i) => `Sentence ${i + 1} explains ${topic} in some detail, so a reader can follow along.`).join(' ');

function page(body: string, title = 'Test page'): Document {
  return new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, {
    url: 'https://example.com/article',
  }).window.document;
}

describe('extractPage on Stack Exchange', () => {
  // Trimmed-down version of Stack Overflow's real question page markup.
  const post = (id: string, text: string, extra = ''): string => `
    <div class="answer js-answer ${extra}" id="answer-${id}">
      <div class="votecell">1234</div>
      <div class="s-prose js-post-body" itemprop="text"><p>${text}</p></div>
      <div class="comments"><span class="comment-copy">Nice answer, thanks!</span></div>
    </div>`;
  const doc = page(`
    <div id="left-sidebar"><nav>Home Questions Tags</nav></div>
    <div id="question-header"><h1><a href="/q/1">Why is processing a sorted array faster?</a></h1></div>
    <div id="mainbar">
      <div class="question js-question" id="question">
        <div class="votecell">27548</div>
        <div class="s-prose js-post-body" itemprop="text">
          <p>In this C++ code, sorting the data makes the primary loop faster.</p>
          <pre><code>for (unsigned c = 0; c &lt; arraySize; ++c)
    if (data[c] &gt;= 128) sum += data[c];</code></pre>
        </div>
        <div class="comments"><span class="comment-copy">Possible duplicate of something.</span></div>
      </div>
      <div id="answers">
        <h2>25 Answers</h2>
        ${post('1', `You are a victim of branch prediction fail. ${prose('branch prediction')}`, 'accepted-answer')}
        ${post('2', `Compilers can remove the branch entirely. ${prose('branchless code')}`)}
      </div>
    </div>
    <div id="sidebar">Hot Network Questions</div>`);

  it('reads the question and every answer, not just the top answer', () => {
    const result = extractPage(doc);

    expect(result.extractor).toBe('stack-exchange');
    expect(result.title).toBe('Why is processing a sorted array faster?');
    expect(result.blocks.filter((b) => b.kind === 'heading').map((b) => b.text)).toEqual([
      'Why is processing a sorted array faster?',
      'Question',
      'Answer 1 (accepted)',
      'Answer 2',
    ]);
    expect(result.text).toContain('sorting the data makes the primary loop faster');
    expect(result.text).toContain('if (data[c] >= 128) sum += data[c];');
    expect(result.text).toContain('victim of branch prediction');
    expect(result.text).toContain('remove the branch entirely');
  });

  it('leaves out comments, votes, sidebars and the "25 Answers" header', () => {
    const { text } = extractPage(doc);
    for (const junk of ['Nice answer', 'Possible duplicate', '27548', 'Hot Network', '25 Answers', 'Tags']) {
      expect(text).not.toContain(junk);
    }
  });
});

describe('extractPage', () => {
  it('uses Readability on an article and keeps headings in order', () => {
    const doc = page(`
      <nav><a href="/">Home</a> <a href="/about">About us</a></nav>
      <article>
        <h1>Neural networks</h1>
        <p>${prose('neural networks')}</p>
        <h2>Backpropagation</h2>
        <p>${prose('backpropagation')}</p>
        <ul><li>${prose('gradients', 2)}</li></ul>
      </article>
      <footer>Copyright 2026 Example Corp. All rights reserved.</footer>
    `);
    const result = extractPage(doc);

    expect(result.extractor).toBe('readability');
    expect(result.url).toBe('https://example.com/article');
    expect(result.text).toContain('explains backpropagation');
    expect(result.text).not.toContain('All rights reserved');
    const headings = result.blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
    expect(headings).toContain('Backpropagation');
    expect(result.wordCount).toBeGreaterThan(100);
    expect(result.truncated).toBe(false);
  });

  it('falls back to visible text when there is no article, skipping nav and hidden elements', () => {
    const doc = page(`
      <nav>Main menu</nav>
      <div><h2>Dashboard</h2>Welcome back.<div hidden>Secret hidden text</div>
        <span aria-hidden="true">decorative</span>
        <button>Click me</button>
      </div>
      <script>var x = 1;</script>
    `);
    const result = extractPage(doc);

    expect(result.extractor).toBe('visible-text');
    expect(result.blocks).toEqual([
      { kind: 'heading', text: 'Dashboard', level: 2 },
      { kind: 'text', text: 'Welcome back.' },
    ]);
    expect(result.title).toBe('Test page');
  });

  it('restores headings Readability drops, and strips anchor marks from them', () => {
    // Wikipedia-style: heading wrapped in a div with an [edit] link beside it.
    const section = (title: string, topic: string): string => `
      <div class="mw-heading mw-heading2"><h2 id="${topic}">${title}</h2>
        <span class="mw-editsection">[<a href="/edit">edit</a>]</span></div>
      <p>${prose(topic)}</p><p>${prose(topic + ' again')}</p>`;
    const doc = page(`<div id="content"><h1>Backprop¶</h1>
      ${section('Overview', 'overview')}${section('Intuition', 'intuition')}${section('History', 'history')}</div>`);

    const result = extractPage(doc);
    const headings = result.blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
    expect(headings).toEqual(expect.arrayContaining(['Overview', 'Intuition', 'History']));
    // Each section's text follows its own heading.
    const at = (s: string): number => result.blocks.findIndex((b) => b.text.includes(s));
    expect(at('Intuition')).toBeLessThan(at('explains intuition'));
    expect(at('explains intuition')).toBeLessThan(at('History'));
    expect(headings.every((h) => !/[¶#]$/.test(h))).toBe(true);
  });

  it('turns a "Heading [edit]" paragraph back into the heading instead of repeating it as text', () => {
    // What Readability returns for Wikipedia in live Chrome: the heading line
    // flattened into a paragraph, edit link and all.
    const source = [
      { kind: 'heading' as const, text: 'Overview', level: 2 },
      { kind: 'text' as const, text: 'Overview body text here.' },
      { kind: 'heading' as const, text: 'Matrix multiplication', level: 2 },
      { kind: 'text' as const, text: 'For the basic case of a feedforward network.' },
    ];
    const readable = [
      { kind: 'text' as const, text: 'Overview body text here.' },
      { kind: 'text' as const, text: 'Matrix multiplication [edit]' },
      { kind: 'text' as const, text: 'For the basic case of a feedforward network.' },
    ];
    expect(restoreHeadings(readable, source)).toEqual([
      { kind: 'heading', text: 'Overview', level: 2 },
      { kind: 'text', text: 'Overview body text here.' },
      { kind: 'heading', text: 'Matrix multiplication', level: 2 },
      { kind: 'text', text: 'For the basic case of a feedforward network.' },
    ]);
  });

  it('keeps inline elements inside their paragraph', () => {
    const doc = page(`<div><p>See <a href="#">the <em>docs</em></a> for more.</p></div>`);
    expect(extractPage(doc).text).toBe('See the docs for more.');
  });

  it('caps very long pages and says so', () => {
    const doc = page(`<article><h1>Long</h1>${`<p>${prose('length', 10)}</p>`.repeat(50)}</article>`);
    const result = extractPage(doc, { maxChars: 1000 });
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.truncated).toBe(true);
  });

  it('returns empty text for an empty page without throwing', () => {
    const result = extractPage(page(''));
    expect(result.text).toBe('');
    expect(result.wordCount).toBe(0);
  });
});
