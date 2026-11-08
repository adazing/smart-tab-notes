/**
 * Splits extracted page text into ~500-token chunks, each tagged with the
 * nearest heading above it. Pure functions, no chrome.* or DOM, so they run
 * anywhere and are easy to test.
 *
 * Token counts are estimated as characters / 4, which is close enough for
 * English prose with OpenAI tokenizers. The backend counts exactly.
 */

import type { TextBlock, TextChunk } from './types';

export const CHARS_PER_TOKEN = 4;

export interface ChunkOptions {
  /** Target size of a chunk. Default 500. */
  targetTokens?: number;
  /**
   * A new heading starts a new chunk only once the current chunk has at
   * least this many tokens, so tiny sections get merged. Default 120.
   */
  minTokens?: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Break one over-long block into pieces of at most `maxChars`, on sentence then word boundaries. */
export function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) ?? [text];
  const pieces: string[] = [];
  let current = '';

  const pushHardSplit = (long: string): void => {
    let rest = long.trim();
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut < maxChars / 2) cut = maxChars;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) current = rest;
  };

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if ((current + sentence).length <= maxChars) {
      current += sentence;
      continue;
    }
    if (current.trim()) pieces.push(current.trim());
    current = '';
    if (sentence.length > maxChars) pushHardSplit(sentence);
    else current = sentence;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

export function chunkBlocks(
  blocks: TextBlock[],
  tabId: number,
  options: ChunkOptions = {},
): TextChunk[] {
  const targetTokens = options.targetTokens ?? 500;
  const minTokens = options.minTokens ?? 120;
  const maxChars = targetTokens * CHARS_PER_TOKEN;

  const chunks: TextChunk[] = [];
  let heading = '';
  let chunkHeading = '';
  let parts: string[] = [];
  let size = 0; // characters in `parts`, including separators

  const flush = (): void => {
    if (parts.length === 0) return;
    const text = parts.join('\n\n');
    const index = chunks.length;
    chunks.push({
      id: `t${tabId}-c${index}`,
      index,
      heading: chunkHeading,
      text,
      tokenEstimate: estimateTokens(text),
    });
    parts = [];
    size = 0;
  };

  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;

    if (block.kind === 'heading') {
      if (size / CHARS_PER_TOKEN >= minTokens) flush();
      heading = text;
      // A heading at the very start of a chunk labels it; keep it in the text too.
      if (parts.length === 0) chunkHeading = heading;
      parts.push(text);
      size += text.length + 2;
      continue;
    }

    for (const piece of splitLongText(text, maxChars)) {
      if (size > 0 && size + piece.length > maxChars) {
        flush();
        chunkHeading = heading;
      }
      if (parts.length === 0) chunkHeading = heading;
      parts.push(piece);
      size += piece.length + 2;
    }
  }
  flush();
  return chunks;
}
