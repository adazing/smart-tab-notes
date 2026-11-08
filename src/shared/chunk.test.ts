import { describe, expect, it } from 'vitest';
import { chunkBlocks, estimateTokens, splitLongText } from './chunk';
import type { TextBlock } from './types';

const sentence = 'The quick brown fox jumps over the lazy dog near the riverbank today. '; // 70 chars
const para = (sentences: number): string => sentence.repeat(sentences).trim();
const h = (text: string, level = 2): TextBlock => ({ kind: 'heading', text, level });
const p = (text: string): TextBlock => ({ kind: 'text', text });

describe('chunkBlocks', () => {
  it('keeps every chunk near the 500-token target and labels it with the nearest heading', () => {
    // ~3 sections of ~1,100 tokens each
    const blocks = [h('Intro'), ...Array(8).fill(p(para(8))), h('Methods'), ...Array(8).fill(p(para(8))), h('Results'), ...Array(8).fill(p(para(8)))];
    const chunks = chunkBlocks(blocks, 42);

    expect(chunks.length).toBeGreaterThanOrEqual(6);
    for (const chunk of chunks) expect(chunk.tokenEstimate).toBeLessThanOrEqual(510);
    expect(chunks[0]!.heading).toBe('Intro');
    expect(chunks.map((c) => c.heading)).toEqual(expect.arrayContaining(['Methods', 'Results']));
    expect(chunks.at(-1)!.heading).toBe('Results');
  });

  it('gives ids unique across tabs and keeps all the text', () => {
    const blocks = [h('A'), p(para(40)), p(para(40))];
    const chunks = chunkBlocks(blocks, 7);
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `t7-c${i}`));
    const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
    expect(chunks.reduce((n, c) => n + words(c.text), 0)).toBe(words(['A', para(40), para(40)].join(' ')));
  });

  it('merges tiny sections instead of making one chunk per heading', () => {
    const blocks = [h('One'), p('Short.'), h('Two'), p('Also short.'), h('Three'), p('Tiny.')];
    const chunks = chunkBlocks(blocks, 1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe('One');
    expect(chunks[0]!.text).toContain('Three');
  });

  it('starts a new chunk at a heading once the current one is big enough', () => {
    const blocks = [h('One'), p(para(10)), h('Two'), p(para(2))];
    const chunks = chunkBlocks(blocks, 1);
    expect(chunks.map((c) => c.heading)).toEqual(['One', 'Two']);
  });

  it('labels text before any heading with an empty heading', () => {
    expect(chunkBlocks([p('Hello there.')], 1)[0]!.heading).toBe('');
  });

  it('returns nothing for no text', () => {
    expect(chunkBlocks([], 1)).toEqual([]);
    expect(chunkBlocks([p('   ')], 1)).toEqual([]);
  });
});

describe('splitLongText', () => {
  it('splits on sentences, then words, never exceeding the limit', () => {
    const pieces = splitLongText(para(100), 2000);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(2000);

    const noPunctuation = 'word '.repeat(1000).trim();
    for (const piece of splitLongText(noPunctuation, 300)) expect(piece.length).toBeLessThanOrEqual(300);
  });

  it('estimates tokens as chars / 4', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});
