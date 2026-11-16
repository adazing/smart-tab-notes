import { describe, expect, it } from 'vitest';
import {
  ANCHOR_CONTEXT_CHARS,
  contextAgreement,
  findAnchor,
  quoteAt,
} from './anchor';
import type { AnnotationTarget } from './types';

const ARTICLE =
  'Transformers replaced recurrence with attention. ' +
  'The attention mechanism weighs every token against every other token. ' +
  'That is why the model scales with sequence length squared. ' +
  'The attention mechanism weighs every token against every other token.';

/** What the content script stores when the user highlights `exact`. */
function target(text: string, exact: string, from = 0): AnnotationTarget {
  const start = text.indexOf(exact, from);
  if (start < 0) throw new Error(`Not in the fixture: ${exact}`);
  const position = { start, end: start + exact.length };
  return { source: 'https://example.com/a', quote: quoteAt(text, position), position };
}

describe('quoteAt', () => {
  it('takes the quote and both sides from one string', () => {
    const quote = quoteAt(ARTICLE, { start: 49, end: 72 });
    expect(quote.exact).toBe('The attention mechanism');
    expect(quote.prefix).toHaveLength(ANCHOR_CONTEXT_CHARS);
    expect(quote.prefix.endsWith('with attention. ')).toBe(true);
    expect(quote.suffix).toBe(' weighs every token against every'.slice(0, ANCHOR_CONTEXT_CHARS));
  });

  it('clamps offsets past either end of the text', () => {
    expect(quoteAt('short', { start: -4, end: 99 })).toEqual({
      exact: 'short', prefix: '', suffix: '',
    });
  });
});

describe('contextAgreement', () => {
  it('scores both sides, and scores a quote saved without context as whole', () => {
    const quote = { exact: 'attention', prefix: 'with ', suffix: '. The' };
    expect(contextAgreement('recurrence with attention. The rest', 16, 25, quote)).toBe(1);
    // Only the space of 'with ' survives on the left; the right side is whole.
    expect(contextAgreement('all attention. The rest', 4, 13, quote)).toBeCloseTo(0.6);
    expect(contextAgreement('x attention y', 2, 11, { exact: 'attention', prefix: '', suffix: '' }))
      .toBe(1);
  });
});

describe('findAnchor: exact strategies', () => {
  it('finds a quote that has not moved, and reports the position strategy', () => {
    const saved = target(ARTICLE, 'scales with sequence length squared');
    expect(findAnchor(ARTICLE, saved)).toEqual({
      start: saved.position.start,
      end: saved.position.end,
      strategy: 'position',
      similarity: 1,
    });
  });

  it('follows a quote that moved when text was inserted above it', () => {
    const saved = target(ARTICLE, 'scales with sequence length squared');
    const edited = 'A newly added opening paragraph about nothing in particular. ' + ARTICLE;
    const match = findAnchor(edited, saved);
    expect(match?.strategy).toBe('quote');
    expect(match?.similarity).toBe(1);
    expect(edited.slice(match!.start, match!.end)).toBe('scales with sequence length squared');
  });

  it('uses the surrounding text to pick between two copies of the same sentence', () => {
    const second = ARTICLE.lastIndexOf('The attention mechanism');
    const saved = target(ARTICLE, 'The attention mechanism weighs every token', second);
    const match = findAnchor(ARTICLE, saved);
    expect(match).toMatchObject({ start: second, strategy: 'position' });

    // The same quote, saved from the first copy, still resolves to the first.
    const first = target(ARTICLE, 'The attention mechanism weighs every token');
    expect(findAnchor(ARTICLE, first)?.start).toBe(ARTICLE.indexOf('The attention mechanism'));
  });

  it('prefers context over the stored offset when both copies survive a shift', () => {
    const second = ARTICLE.lastIndexOf('The attention mechanism');
    const saved = target(ARTICLE, 'The attention mechanism weighs every token', second);
    const edited = ARTICLE.replace('Transformers replaced recurrence with attention. ', '');
    const match = findAnchor(edited, saved);
    expect(match?.strategy).toBe('quote');
    expect(match?.start).toBe(edited.lastIndexOf('The attention mechanism'));
  });
});

describe('findAnchor: fuzzy strategy', () => {
  it('re-finds a sentence that was edited in place', () => {
    const saved = target(ARTICLE, 'That is why the model scales with sequence length squared');
    const edited = ARTICLE.replace(
      'That is why the model scales with sequence length squared',
      'That is why this model scales with the sequence length squared',
    );
    const match = findAnchor(edited, saved);
    expect(match?.strategy).toBe('fuzzy');
    expect(match!.similarity).toBeGreaterThan(0.8);
    expect(edited.slice(match!.start, match!.end))
      .toBe('That is why this model scales with the sequence length squared');
  });

  it('re-finds a short quote after a word inside it changed', () => {
    const saved = target(ARTICLE, 'replaced recurrence');
    const edited = ARTICLE.replace('replaced recurrence', 'replaced recursion');
    const match = findAnchor(edited, saved);
    expect(match?.strategy).toBe('fuzzy');
    expect(edited.slice(match!.start, match!.end)).toContain('recursion');
  });

  it('survives an edit to the start of a long quote', () => {
    const saved = target(ARTICLE, 'That is why the model scales with sequence length squared');
    const edited = ARTICLE.replace(
      'That is why the model scales',
      'This, in the end, is why the model scales',
    );
    const match = findAnchor(edited, saved);
    expect(match?.strategy).toBe('fuzzy');
    expect(edited.slice(match!.start, match!.end))
      .toBe('This, in the end, is why the model scales with sequence length squared');
  });

  it('keeps the whole sentence, and does not run into the next one', () => {
    const exact =
      'The model scales quadratically with sequence length, which is why long documents are expensive.';
    const page = `Transformers replaced recurrence. ${exact} Sparse attention trades exactness for speed.`;
    const start = page.indexOf(exact);
    const position = { start, end: start + exact.length };
    const saved = { source: 'https://example.com/a', quote: quoteAt(page, position), position };

    const edited = page
      .replace('with sequence length', 'with the sequence length')
      .replace('documents are expensive', 'documents get expensive');
    const match = findAnchor(edited, saved)!;
    expect(match.strategy).toBe('fuzzy');
    expect(edited.slice(match.start, match.end)).toBe(
      'The model scales quadratically with the sequence length, which is why long documents get expensive.',
    );
    expect(match.similarity).toBeGreaterThan(0.9);
  });

  it('gives up rather than anchoring a note to unrelated text', () => {
    const saved = target(ARTICLE, 'scales with sequence length squared');
    const rewritten =
      'This page now discusses the migratory patterns of arctic terns, ' +
      'which have nothing to do with the previous subject at all.';
    expect(findAnchor(rewritten, saved)).toBeNull();
  });

  it('can be turned off, leaving only exact matches', () => {
    const saved = target(ARTICLE, 'replaced recurrence');
    const edited = ARTICLE.replace('replaced recurrence', 'replaced recursion');
    expect(findAnchor(edited, saved, { minSimilarity: 2 })).toBeNull();
    expect(findAnchor(ARTICLE, saved, { minSimilarity: 2 })?.strategy).toBe('position');
  });
});

describe('findAnchor: edges', () => {
  it('returns null for empty page text or an empty quote', () => {
    const saved = target(ARTICLE, 'attention');
    expect(findAnchor('', saved)).toBeNull();
    expect(findAnchor(ARTICLE, { quote: { exact: '', prefix: '', suffix: '' } })).toBeNull();
  });

  it('works without a stored position, using only the quote and its context', () => {
    const match = findAnchor(ARTICLE, {
      quote: { exact: 'attention mechanism', prefix: 'The ', suffix: ' weighs' },
    });
    expect(match).toMatchObject({ strategy: 'quote', similarity: 1 });
    expect(ARTICLE.slice(match!.start, match!.end)).toBe('attention mechanism');
  });

  it('tolerates a stored position that is now past the end of the page', () => {
    const saved = target(ARTICLE, 'attention mechanism');
    const shortened = ARTICLE.slice(0, 120);
    const match = findAnchor(shortened, { ...saved, position: { start: 9_000, end: 9_020 } });
    expect(shortened.slice(match!.start, match!.end)).toBe('attention mechanism');
  });
});
