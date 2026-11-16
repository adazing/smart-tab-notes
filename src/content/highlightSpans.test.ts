// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_ATTRIBUTE,
  highlightIdAt,
  paintPieces,
  unpaint,
} from './highlightSpans';
import { buildTextIndex, piecesFromOffsets } from './textIndex';

const MARKUP =
  '<p id="text">Transformers replaced <a href="/rnn">recurrent networks</a> entirely, ' +
  'and attention is all you need.</p>';

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});

/** Paint the given quote the way the annotation layer does. */
function highlight(quote: string, id: string, approximate = false): HTMLElement[] {
  const index = buildTextIndex();
  const start = index.text.indexOf(quote);
  if (start < 0) throw new Error(`Not on the page: ${quote}`);
  return paintPieces(piecesFromOffsets(index, start, start + quote.length), { id, approximate });
}

function spans(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${HIGHLIGHT_ATTRIBUTE}]`)];
}

describe('paintPieces', () => {
  it('wraps the quote without changing the text or the markup around it', () => {
    const painted = highlight('replaced recurrent networks entirely', 'note-1');

    expect(painted).toHaveLength(3);
    expect(document.body.textContent).toBe(
      'Transformers replaced recurrent networks entirely, and attention is all you need.',
    );
    // The link still exists, is still a link, and still has its href.
    const link = document.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/rnn');
    expect(link.textContent).toBe('recurrent networks');
    expect(painted.map((span) => span.textContent))
      .toEqual(['replaced ', 'recurrent networks', ' entirely']);
  });

  it('only paints: no inline style can move the text around', () => {
    const [span] = highlight('attention', 'note-1');
    const style = span!.getAttribute('style') ?? '';
    expect(style).toContain('background-color');
    expect(span!.style.getPropertyPriority('background-color')).toBe('important');
    for (const layout of ['display', 'margin', 'padding', 'font', 'line-height', 'position']) {
      expect(style).not.toContain(layout);
    }
  });

  it('carries the note id and adds one tab stop for the whole highlight', () => {
    const painted = highlight('replaced recurrent networks entirely', 'note-7');
    expect(painted.every((span) => span.getAttribute(HIGHLIGHT_ATTRIBUTE) === 'note-7')).toBe(true);
    expect(painted.map((span) => span.tabIndex)).toEqual([0, -1, -1]);
    expect(painted.every((span) => span.getAttribute('role') === 'mark')).toBe(true);
  });

  it('draws an approximate match more faintly', () => {
    const [exact] = highlight('Transformers', 'note-1');
    const [fuzzy] = highlight('you need', 'note-2', true);
    expect(exact!.style.backgroundColor).not.toBe(fuzzy!.style.backgroundColor);
  });

  it('keeps two highlights in the same text node apart', () => {
    highlight('and attention', 'note-late');
    highlight('Transformers replaced', 'note-early');

    expect(spans()).toHaveLength(2);
    expect(document.body.textContent).toBe(
      'Transformers replaced recurrent networks entirely, and attention is all you need.',
    );
    expect(spans().map((span) => span.getAttribute(HIGHLIGHT_ATTRIBUTE)))
      .toEqual(['note-early', 'note-late']);
    expect(spans().map((span) => span.textContent)).toEqual(['Transformers replaced', 'and attention']);
  });

  it('ignores a piece whose text node the page has already thrown away', () => {
    const index = buildTextIndex();
    const pieces = piecesFromOffsets(index, 0, 12);
    document.body.innerHTML = '<p>Replaced by the page</p>';
    expect(paintPieces(pieces, { id: 'note-1' })).toEqual([]);
  });
});

describe('unpaint', () => {
  it('puts the page back exactly as it was', () => {
    const painted = highlight('replaced recurrent networks entirely', 'note-1');
    expect(document.body.innerHTML).not.toBe(MARKUP);

    unpaint(painted);
    expect(document.body.innerHTML).toBe(MARKUP);
    expect(spans()).toEqual([]);
    // The split text nodes were merged back, so the next index is clean.
    expect(document.querySelector('#text')!.childNodes).toHaveLength(3);
  });

  it('survives spans the page has already removed', () => {
    const painted = highlight('Transformers', 'note-1');
    document.body.innerHTML = '<p>Something else entirely</p>';
    expect(() => unpaint(painted)).not.toThrow();
  });
});

describe('highlightIdAt', () => {
  it('finds the note id from a node inside a highlight, and nothing elsewhere', () => {
    highlight('recurrent networks', 'note-9');
    const span = spans()[0]!;
    expect(highlightIdAt(span)).toBe('note-9');
    expect(highlightIdAt(span.firstChild)).toBe('note-9');
    expect(highlightIdAt(document.querySelector('#text'))).toBeNull();
    expect(highlightIdAt(null)).toBeNull();
  });
});
