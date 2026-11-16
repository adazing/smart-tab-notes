/**
 * Drawing a highlight into the page, and taking it back out.
 *
 * Each highlight becomes one `<span>` per text node it covers: text nodes
 * are split at the edges of the quote and the middle is wrapped, so no
 * element boundary is ever crossed and a sentence with a link in it gets
 * three spans rather than one illegal one.
 *
 * The spans carry inline styles only, marked `!important`, and only
 * properties that paint: a background, a corner radius, a cursor. Nothing
 * here changes `display`, spacing or font, so a wrapped sentence reflows
 * exactly as it did before -- which is the point. Page CSS cannot easily
 * fight the inline styles, and removing the spans with `unpaint` restores
 * the original text nodes.
 */

import type { TextPiece } from './textIndex';

/** The span attribute that carries the saved note's id. */
export const HIGHLIGHT_ATTRIBUTE = 'data-smart-tab-notes-highlight';

/** Matches every highlight span we have drawn. */
export const HIGHLIGHT_SELECTOR = `[${HIGHLIGHT_ATTRIBUTE}]`;

/** Painted properties only: nothing that could move text around. */
const HIGHLIGHT_STYLE: ReadonlyArray<readonly [string, string]> = [
  ['background-color', 'rgba(255, 201, 64, 0.45)'],
  ['border-radius', '2px'],
  ['box-decoration-break', 'clone'],
  ['cursor', 'pointer'],
];

/** A highlight whose quote was only found approximately, drawn paler. */
const APPROXIMATE_BACKGROUND = 'rgba(255, 201, 64, 0.28)';

export interface PaintOptions {
  /** Id of the saved note, so events on the span can find it again. */
  id: string;
  /** True when the quote was re-found by fuzzy matching. */
  approximate?: boolean;
}

/** Split one text node and wrap the slice between the offsets. */
function wrapSlice(piece: TextPiece): HTMLSpanElement | null {
  const node = piece.node;
  if (!node.isConnected || node.parentNode === null) return null;

  const start = Math.max(0, Math.min(piece.start, node.data.length));
  const end = Math.max(start, Math.min(piece.end, node.data.length));
  if (end === start) return null;

  if (end < node.data.length) node.splitText(end);
  const slice = start > 0 ? node.splitText(start) : node;
  const parent = slice.parentNode;
  if (parent === null) return null;

  const span = document.createElement('span');
  parent.replaceChild(span, slice);
  span.append(slice);
  return span;
}

/**
 * Wrap every piece of one highlight, and return its spans in document
 * order.
 *
 * Pieces inside the same text node are wrapped back to front: splitting a
 * node leaves everything before the cut in the original node, so the
 * offsets of the pieces still to come stay correct.
 */
export function paintPieces(pieces: TextPiece[], options: PaintOptions): HTMLSpanElement[] {
  const groups = new Map<Text, { order: number; piece: TextPiece }[]>();
  pieces.forEach((piece, order) => {
    if (piece.end <= piece.start) return;
    const group = groups.get(piece.node);
    if (group) group.push({ order, piece });
    else groups.set(piece.node, [{ order, piece }]);
  });

  const painted: { order: number; span: HTMLSpanElement }[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => right.piece.start - left.piece.start);
    for (const { order, piece } of group) {
      const span = wrapSlice(piece);
      if (span) painted.push({ order, span });
    }
  }

  painted.sort((left, right) => left.order - right.order);
  const spans = painted.map((entry) => entry.span);
  spans.forEach((span, position) => {
    span.setAttribute(HIGHLIGHT_ATTRIBUTE, options.id);
    span.setAttribute('role', 'mark');
    for (const [property, value] of HIGHLIGHT_STYLE) {
      span.style.setProperty(property, value, 'important');
    }
    if (options.approximate) {
      span.style.setProperty('background-color', APPROXIMATE_BACKGROUND, 'important');
    }
    // One tab stop per note, not one per piece.
    if (position === 0) span.tabIndex = 0;
  });
  return spans;
}

/**
 * Put the page back: unwrap the spans and merge the text nodes they split.
 * Safe to call on spans the page has already removed.
 */
export function unpaint(spans: Iterable<HTMLElement>): void {
  for (const span of spans) {
    const parent = span.parentNode;
    if (parent === null) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }
}

/** The note id for an event target inside a highlight, if it is in one. */
export function highlightIdAt(target: EventTarget | null): string | null {
  const node = target instanceof Node ? target : null;
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest(HIGHLIGHT_SELECTOR)?.getAttribute(HIGHLIGHT_ATTRIBUTE) ?? null;
}
