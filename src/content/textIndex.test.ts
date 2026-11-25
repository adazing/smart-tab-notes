// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildTextIndex,
  offsetsFromRange,
  piecesFromOffsets,
  targetFromRange,
} from './textIndex';
import { findAnchor } from '../shared/anchor';

const PAGE = `
  <h1>Attention   is all you need</h1>
  <p id="first">Transformers replaced <a href="/rnn">recurrent networks</a> entirely.</p>
  <p id="second">
    The model
    scales quadratically.<br>Memory is the limit.
  </p>
  <script>const ignored = 'script text';</script>
  <style>.ignored { color: red }</style>
  <textarea>draft text</textarea>
  <p hidden>Hidden paragraph.</p>
  <div data-smart-tab-notes=""><p>Extension UI</p></div>
`;

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

/** A Range over the contents of one element, as a selection would give. */
function selectContents(selector: string): Range {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(selector)!);
  return range;
}

describe('buildTextIndex', () => {
  it('reads the page as the browser renders it, one space at a time', () => {
    expect(buildTextIndex().text.trimEnd()).toBe(
      'Attention is all you need ' +
      'Transformers replaced recurrent networks entirely. ' +
      'The model scales quadratically. Memory is the limit.',
    );
  });

  it('leaves out scripts, styles, form controls, hidden text and our own UI', () => {
    const { text } = buildTextIndex();
    for (const absent of ['script text', 'ignored', 'draft text', 'Hidden paragraph', 'Extension UI']) {
      expect(text).not.toContain(absent);
    }
  });

  it('maps every segment back to the text node it came from', () => {
    const { text, segments } = buildTextIndex();
    expect(segments.length).toBeGreaterThan(5);
    for (const segment of segments) {
      const fromNode = segment.node.data.slice(
        segment.nodeOffset, segment.nodeOffset + segment.length,
      );
      const fromIndex = text.slice(segment.textOffset, segment.textOffset + segment.length);
      // A run of whitespace in the page is one space in the index, mapped
      // to the first character of the run.
      expect(fromIndex).toBe(/\s/.test(fromNode) ? ' ' : fromNode);
    }
  });

  it('keeps the boundary space when the first run is not inside a block', () => {
    // BODY is not a block tag, so the nearest block of a bare text run is
    // null. That must not read as "same block as the run before".
    document.body.innerHTML = 'Intro text<div>Chapter one</div>';
    expect(buildTextIndex().text).toBe('Intro text Chapter one');

    document.body.innerHTML = '<span>Hello</span><p>World</p>';
    expect(buildTextIndex().text).toBe('Hello World');
  });

  it('returns an empty index for an empty page rather than failing', () => {
    document.body.innerHTML = '';
    expect(buildTextIndex()).toEqual({ text: '', segments: [] });
  });
});

describe('offsetsFromRange', () => {
  it('finds a selection that crosses a link, ignoring markup whitespace', () => {
    const index = buildTextIndex();
    const position = offsetsFromRange(index, selectContents('#first'))!;
    expect(index.text.slice(position.start, position.end))
      .toBe('Transformers replaced recurrent networks entirely.');
  });

  it('finds a selection inside one text node', () => {
    const index = buildTextIndex();
    const node = document.querySelector('#first')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 'Transformers '.length);
    range.setEnd(node, 'Transformers replaced'.length);
    const position = offsetsFromRange(index, range)!;
    expect(index.text.slice(position.start, position.end)).toBe('replaced');
  });

  it('collapses the markup indentation and the <br> inside a paragraph', () => {
    const index = buildTextIndex();
    const position = offsetsFromRange(index, selectContents('#second'))!;
    expect(index.text.slice(position.start, position.end))
      .toBe('The model scales quadratically. Memory is the limit.');
  });

  it('returns null for a collapsed range and for text it cannot see', () => {
    const index = buildTextIndex();
    const collapsed = document.createRange();
    collapsed.setStart(document.querySelector('#first')!.firstChild!, 3);
    collapsed.collapse(true);
    expect(offsetsFromRange(index, collapsed)).toBeNull();
    expect(offsetsFromRange(index, selectContents('[hidden]'))).toBeNull();
  });
});

describe('targetFromRange', () => {
  it('stores the quote with the text on both sides of it', () => {
    const index = buildTextIndex();
    const node = document.querySelector('#first')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 'Transformers '.length);
    range.setEnd(node, 'Transformers replaced'.length);
    const target = targetFromRange(index, range, 'https://example.com/paper')!;

    expect(target.source).toBe('https://example.com/paper');
    expect(target.quote.exact).toBe('replaced');
    expect(target.quote.prefix.endsWith('Transformers ')).toBe(true);
    expect(target.quote.suffix.startsWith(' recurrent networks')).toBe(true);
    expect(index.text.slice(target.position.start, target.position.end)).toBe('replaced');
  });

  it('returns null when the range covers no page text', () => {
    const index = buildTextIndex();
    expect(targetFromRange(index, selectContents('textarea'), 'https://example.com')).toBeNull();
  });
});

describe('piecesFromOffsets', () => {
  it('splits one quote into one piece per text node it crosses', () => {
    const index = buildTextIndex();
    const position = offsetsFromRange(index, selectContents('#first'))!;
    const pieces = piecesFromOffsets(index, position.start, position.end);

    expect(pieces).toHaveLength(3);
    expect(pieces.map((piece) => piece.node.data.slice(piece.start, piece.end))).toEqual([
      'Transformers replaced ', 'recurrent networks', ' entirely.',
    ]);
    for (const piece of pieces) expect(piece.node.parentElement?.closest('#first')).toBeTruthy();
  });

  it('covers part of a text node when the quote starts mid-node', () => {
    const index = buildTextIndex();
    const start = index.text.indexOf('replaced');
    const pieces = piecesFromOffsets(index, start, start + 'replaced'.length);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.node.data.slice(pieces[0]!.start, pieces[0]!.end)).toBe('replaced');
  });

  it('returns nothing for a range past the end of the page', () => {
    const index = buildTextIndex();
    expect(piecesFromOffsets(index, 9_000, 9_100)).toEqual([]);
  });
});

describe('a quote saved from one DOM and found in another', () => {
  it('survives markup being reflowed and text being added above it', () => {
    const index = buildTextIndex();
    const target = targetFromRange(index, selectContents('#second'), 'https://example.com')!;

    // Same words, different markup, with a new paragraph above.
    document.body.innerHTML = `
      <p>A paragraph that was not there before.</p>
      <p id="second"><em>The</em> model scales quadratically. Memory is the limit.</p>
    `;
    const rebuilt = buildTextIndex();
    const match = findAnchor(rebuilt.text, target)!;
    expect(match.strategy).toBe('quote');

    const pieces = piecesFromOffsets(rebuilt, match.start, match.end);
    expect(pieces.map((piece) => piece.node.data.slice(piece.start, piece.end)).join(''))
      .toBe('The model scales quadratically. Memory is the limit.');
  });

  it('survives the quote itself being edited', () => {
    const index = buildTextIndex();
    const target = targetFromRange(index, selectContents('#first'), 'https://example.com')!;

    document.body.innerHTML = '<p id="first">Transformers replaced recurrent layers entirely.</p>';
    const rebuilt = buildTextIndex();
    const match = findAnchor(rebuilt.text, target)!;
    expect(match.strategy).toBe('fuzzy');
    expect(rebuilt.text.slice(match.start, match.end)).toContain('recurrent layers');
  });
});
