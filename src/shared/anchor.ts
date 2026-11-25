/**
 * Finding a saved quote in page text again.
 *
 * This module is pure text work: give it the page's normalized text and a
 * stored W3C selector pair, and it tells you where the quote is now. The
 * DOM side -- turning a Range into offsets and offsets back into highlight
 * spans -- lives in `content/textIndex.ts`.
 *
 * Three strategies, in the order the anchoring ticket asks for:
 *
 *   position  the quote is still exactly where it was saved
 *   quote     the quote is elsewhere; prefix/suffix say which copy it is
 *   fuzzy     the text itself changed; diff-match-patch finds the nearest
 *             surviving version of it
 *
 * Nothing here throws, and nothing here mutates its arguments. When no
 * strategy works the caller gets `null`, which is the signal to mark the
 * note orphaned rather than to drop it.
 */

import DiffMatchPatch from 'diff-match-patch';
import type {
  AnchorMatch,
  AnchorStrategy,
  TextPositionSelector,
  TextQuoteSelector,
} from './types';

/** How much text we keep on each side of a quote. */
export const ANCHOR_CONTEXT_CHARS = 32;

/**
 * How close a fuzzy match has to be to count, as 1 - (edits / length).
 * 0.7 accepts a changed word in a short quote or a reworded clause in a
 * long one, and rejects a different sentence that happens to start the
 * same way.
 */
export const FUZZY_MIN_SIMILARITY = 0.7;

/**
 * How much the surrounding text counts when two spots match the quote
 * about equally well. Similarity decides mostly, but context is what tells
 * a slightly truncated match apart from the whole one.
 */
const CONTEXT_WEIGHT = 0.25;

/**
 * How much a fuzzy match is allowed to change length before the drift
 * starts costing it. Higher means more tolerant.
 */
const LENGTH_PRIOR = 4;

/** Stop collecting repeats of a quote; a page with more is not using them to disambiguate. */
const MAX_EXACT_OCCURRENCES = 64;

/** Everything needed to re-find a quote. `position` is a hint and may be missing. */
export interface AnchorSelectors {
  quote: TextQuoteSelector;
  position?: TextPositionSelector;
}

export interface AnchorOptions {
  /** Defaults to FUZZY_MIN_SIMILARITY. Above 1 disables fuzzy matching. */
  minSimilarity?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/**
 * How much of the stored surrounding text the page still agrees with at
 * this spot, from 0 (nothing) to 1 (both sides whole). A quote saved with
 * no context scores 1: there is nothing to disagree with.
 */
export function contextAgreement(
  text: string, start: number, end: number, quote: TextQuoteSelector,
): number {
  const { prefix, suffix } = quote;
  const before = text.slice(Math.max(0, start - prefix.length), start);
  const after = text.slice(end, end + suffix.length);
  const left = prefix.length === 0 ? 1 : commonSuffixLength(before, prefix) / prefix.length;
  const right = suffix.length === 0 ? 1 : commonPrefixLength(after, suffix) / suffix.length;
  return (left + right) / 2;
}

/** Every offset where `exact` appears verbatim, up to the cap. */
function exactOccurrences(text: string, exact: string): number[] {
  const found: number[] = [];
  let from = text.indexOf(exact);
  while (from !== -1 && found.length < MAX_EXACT_OCCURRENCES) {
    found.push(from);
    from = text.indexOf(exact, from + 1);
  }
  return found;
}

/**
 * The quote and the text around it at a given offset range, ready to store.
 * Taking all three from one string is what keeps the selectors consistent.
 */
export function quoteAt(
  text: string, position: TextPositionSelector, contextChars = ANCHOR_CONTEXT_CHARS,
): TextQuoteSelector {
  const start = clamp(position.start, 0, text.length);
  const end = clamp(position.end, start, text.length);
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - contextChars), start),
    suffix: text.slice(end, end + contextChars),
  };
}

/**
 * The quote, verbatim. Of several copies, the one whose surrounding text
 * matches best, and on a tie the one nearest where it was saved.
 */
function findExact(text: string, selectors: AnchorSelectors): AnchorMatch | null {
  const { quote, position } = selectors;
  const hits = exactOccurrences(text, quote.exact);
  if (hits.length === 0) return null;

  const expected = position ? clamp(position.start, 0, text.length) : 0;
  let best = hits[0] as number;
  let bestContext = -1;
  for (const start of hits) {
    const context = contextAgreement(text, start, start + quote.exact.length, quote);
    const better =
      context > bestContext + 1e-9 ||
      (Math.abs(context - bestContext) <= 1e-9 &&
        Math.abs(start - expected) < Math.abs(best - expected));
    if (better) {
      best = start;
      bestContext = context;
    }
  }

  const strategy: AnchorStrategy = position && best === position.start ? 'position' : 'quote';
  return { start: best, end: best + quote.exact.length, strategy, similarity: 1 };
}

/**
 * Align `exact` against the page text starting at `start`, and say where it
 * ends and how close it is.
 *
 * The window is deliberately longer than the quote so that inserted words
 * still fit inside it, which makes the end the interesting part. Four
 * sources offer a candidate: the quote's own length, the runs the two
 * strings still have in common, the point where the quote runs out, and a
 * search for the quote's last 32 characters inside the window -- the same
 * trick that found the start, applied to the other edge. Each candidate is
 * then measured in full, with a mild preference for keeping the quote's
 * original length, because a diff will otherwise happily run on into the
 * next sentence for the sake of a letter or two.
 */
function alignWindow(
  dmp: DiffMatchPatch, text: string, exact: string, start: number,
): { end: number; similarity: number } | null {
  const window = text.slice(start, Math.ceil(start + exact.length * 1.5) + 32);
  if (window.length === 0) return null;

  const ends = new Set<number>([Math.min(exact.length, window.length)]);

  const tail = exact.slice(-Math.min(exact.length, dmp.Match_MaxBits));
  const tailLocation = dmp.match_main(window, tail, Math.max(0, exact.length - tail.length));
  if (tailLocation !== -1) ends.add(Math.min(window.length, tailLocation + tail.length));

  const diffs = dmp.diff_main(exact, window);
  // Without this, the raw diff happily matches single letters of the quote
  // against letters of the next sentence ('ar' of 'are' against 'Sparse').
  // Semantic cleanup coalesces those into one edit, which is what a reader
  // would call the difference between the two versions.
  dmp.diff_cleanupSemantic(diffs);
  let consumed = 0;
  let produced = 0;
  for (let i = 0; i < diffs.length; i += 1) {
    const [operation, data] = diffs[i] as [number, string];
    if (operation !== DiffMatchPatch.DIFF_INSERT) consumed += data.length;
    if (operation !== DiffMatchPatch.DIFF_DELETE) produced += data.length;
    if (operation === DiffMatchPatch.DIFF_EQUAL) ends.add(produced);
    if (consumed >= exact.length) {
      ends.add(produced);
      // Text that took the place of the quote's tail belongs to the quote.
      const next = diffs[i + 1];
      if (next && next[0] === DiffMatchPatch.DIFF_INSERT) ends.add(produced + next[1].length);
      break;
    }
  }

  let best: { end: number; similarity: number } | null = null;
  let bestScore = -Infinity;
  for (const end of ends) {
    if (end === 0) continue;
    const matched = window.slice(0, end);
    const edits = dmp.diff_levenshtein(dmp.diff_main(exact, matched));
    const similarity = 1 - edits / Math.max(exact.length, matched.length);
    // Growing or shrinking by a quarter of the quote costs about 0.06 of
    // similarity: enough to settle a near-tie, not enough to override a
    // genuinely better match.
    const drift = Math.abs(matched.length - exact.length);
    const score = similarity - drift / (LENGTH_PRIOR * exact.length);
    if (score > bestScore) {
      best = { end: start + end, similarity };
      bestScore = score;
    }
  }
  return best;
}

/**
 * The closest surviving version of the quote.
 *
 * diff-match-patch's bitap search takes patterns of at most 32 characters,
 * so longer quotes are located by their first 32 characters and, as a
 * second candidate, by their last 32 -- the same head/tail trick
 * `patch_apply` uses internally. Every candidate is then checked in full,
 * so a head that matches the wrong sentence is thrown away.
 */
function findFuzzy(
  text: string, selectors: AnchorSelectors, minSimilarity: number,
): AnchorMatch | null {
  if (minSimilarity > 1) return null;
  const { quote, position } = selectors;
  const exact = quote.exact;

  const dmp = new DiffMatchPatch();
  // Weak location bias: an edit anywhere above the quote shifts its offset,
  // sometimes by a lot, and the full check below is what decides anyway.
  dmp.Match_Distance = Math.max(1000, text.length * 4);
  dmp.Match_Threshold = 0.5;
  dmp.Diff_Timeout = 0.2;

  const bits = dmp.Match_MaxBits;
  const hint = clamp(position?.start ?? 0, 0, text.length);
  const starts = new Set<number>();

  const headLocation = dmp.match_main(text, exact.slice(0, Math.min(exact.length, bits)), hint);
  if (headLocation !== -1) starts.add(headLocation);

  if (exact.length > bits) {
    const tailHint = clamp((position?.end ?? hint + exact.length) - bits, 0, text.length);
    const tailLocation = dmp.match_main(text, exact.slice(-bits), tailHint);
    if (tailLocation !== -1) {
      starts.add(clamp(tailLocation + bits - exact.length, 0, text.length));
    }
  }
  // Both ends may have changed while the middle survived.
  if (position) starts.add(hint);

  let best: AnchorMatch | null = null;
  let bestScore = -1;
  for (const start of starts) {
    const aligned = alignWindow(dmp, text, exact, start);
    if (!aligned || aligned.similarity < minSimilarity) continue;
    // Two spots can both look like the quote -- typically the whole
    // sentence and the part of it after an edited opening. Weighing the
    // surrounding text in picks the one that sits where the quote sat.
    const context = contextAgreement(text, start, aligned.end, quote);
    const score = aligned.similarity * (1 - CONTEXT_WEIGHT) + context * CONTEXT_WEIGHT;
    if (score > bestScore) {
      best = { start, end: aligned.end, strategy: 'fuzzy', similarity: aligned.similarity };
      bestScore = score;
    }
  }
  return best;
}

/**
 * Where a saved quote is in this page text now, or `null` if it has gone.
 *
 *   const match = findAnchor(index.text, annotation.target);
 *   if (!match) markOrphaned(annotation);
 */
export function findAnchor(
  text: string, selectors: AnchorSelectors, options: AnchorOptions = {},
): AnchorMatch | null {
  if (text.length === 0 || selectors.quote.exact.length === 0) return null;
  return (
    findExact(text, selectors) ??
    findFuzzy(text, selectors, options.minSimilarity ?? FUZZY_MIN_SIMILARITY)
  );
}
