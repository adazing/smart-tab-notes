/**
 * Turning a /chat answer's inline `[chunk_id]` markers into numbered chips.
 *
 * docs/api.md: a `[…]` whose contents is a chunk id we sent is a citation;
 * anything else in brackets is plain text. The `done` event's `citations`
 * gives each cited chunk its chip number `n`. While streaming we number
 * chunks in order of first use, which is the same rule the server uses.
 */

import type { Citation } from '../shared/api';

export type { Citation };

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; chunkId: string; n: number };

const MARKER = /\[([A-Za-z0-9_.:-]{1,64})\]/g;
/** An unfinished marker at the end of a streaming answer, like `[t101-c`. */
const PARTIAL_MARKER = /\[[A-Za-z0-9_.:-]{0,64}$/;

/**
 * Split `answer` into text and citation segments.
 *
 * - `sentIds`: every chunk id sent with the request.
 * - `citations`: from the `done` event, or null while streaming. Once given,
 *   it is authoritative: markers it dropped are removed.
 * - `streaming`: hide a half-arrived marker at the end instead of flashing it.
 */
export function splitCitations(
  answer: string,
  sentIds: ReadonlySet<string>,
  citations: readonly Citation[] | null,
  streaming = false,
): Segment[] {
  let text = answer;
  if (streaming) {
    const partial = PARTIAL_MARKER.exec(text);
    if (partial) text = text.slice(0, partial.index);
  }
  const numbers = new Map<string, number>(citations?.map((c) => [c.chunk_id, c.n]) ?? []);
  const segments: Segment[] = [];
  let last = 0;
  const push = (piece: string): void => {
    if (!piece) return;
    const previous = segments.at(-1);
    if (previous?.kind === 'text') previous.text += piece;
    else segments.push({ kind: 'text', text: piece });
  };
  for (const match of text.matchAll(MARKER)) {
    const id = match[1]!;
    if (!sentIds.has(id)) continue; // plain text such as "[1]"
    let before = text.slice(last, match.index);
    last = match.index! + match[0].length;
    let n = numbers.get(id);
    if (n === undefined && citations) {
      // The server dropped it: remove the marker, and the space before it
      // when punctuation follows ("word [x]." -> "word.").
      if (/^[.,;:!?]/.test(text.slice(last))) before = before.replace(/ +$/, '');
      push(before);
      continue;
    }
    push(before);
    if (n === undefined) {
      n = numbers.size + 1;
      numbers.set(id, n);
    }
    segments.push({ kind: 'cite', chunkId: id, n });
  }
  push(text.slice(last));
  return segments;
}
