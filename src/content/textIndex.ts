/**
 * The page's text, and the way back to the DOM.
 *
 * Anchoring needs one string for the whole page: `shared/anchor.ts` works
 * on text, not nodes. This module builds that string, keeps a map from
 * every character back to the text node it came from, and offers the two
 * conversions the annotation layer needs:
 *
 *   a Range the user selected  ->  the W3C selectors we store
 *   stored offsets            ->  the text node slices to wrap in spans
 *
 * WHITESPACE: runs of whitespace collapse to one space, as the browser
 * renders them, and paragraph and <br> boundaries become one space too.
 * This is what makes a quote survive re-indented or reflowed markup, and
 * it is why a stored quote comes from here rather than from
 * `Selection.toString()`: the saved text and the text we search later have
 * to be normalized the same way.
 *
 * The index is a snapshot. Anything that changes the page invalidates it,
 * so the annotation layer throws it away and builds a new one rather than
 * patching it.
 */

import { quoteAt } from '../shared/anchor';
import type { AnnotationTarget, TextPositionSelector } from '../shared/types';

/** One run of characters that survived normalization, and where it came from. */
export interface TextSegment {
  node: Text;
  /** Offset of the run inside `node.data`. */
  nodeOffset: number;
  /** Offset of the run inside `TextIndex.text`. */
  textOffset: number;
  length: number;
}

export interface TextIndex {
  /** Normalized text of the whole root. */
  text: string;
  /** Document order, non-overlapping. */
  segments: TextSegment[];
}

/** A slice of one text node: what a highlight span wraps. */
export interface TextPiece {
  node: Text;
  start: number;
  end: number;
}

/**
 * Subtrees with no readable page text. Form controls are here because the
 * selection toolbar refuses to annotate them, so their text must not shift
 * everything else's offsets either.
 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
  'CANVAS', 'AUDIO', 'VIDEO', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP',
  'DATALIST', 'INPUT', 'BUTTON',
  // Text in the document that the browser does not render: the LaTeX source
  // MathML carries alongside its markup, and SVG's accessibility strings.
  // Wikipedia articles with formulas are full of the first kind, and a quote
  // with LaTeX in it matches nothing a reader can see.
  'ANNOTATION', 'ANNOTATION-XML', 'TITLE', 'DESC', 'METADATA',
]);

/**
 * Where the browser would render a line break. Used to keep a space
 * between paragraphs, which markup does not always provide.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS',
  'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
  'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/** The extension's own shadow hosts, which are not page content. */
const OWN_UI = '[data-smart-tab-notes]';

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

function closestBlock(node: Node): Element | null {
  for (let current = node.parentElement; current; current = current.parentElement) {
    if (BLOCK_TAGS.has(current.tagName.toUpperCase())) return current;
  }
  return null;
}

/**
 * Read the page as one normalized string, remembering where every run of
 * characters came from.
 */
export function buildTextIndex(root: Node = document.body): TextIndex {
  const segments: TextSegment[] = [];
  let text = '';
  if (!root) return { text, segments };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node): number {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const element = node as Element;
      // MathML and SVG tag names keep their authored case, so normalize.
      const tag = element.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
      if (element.hasAttribute('hidden') || element.matches(OWN_UI)) {
        return NodeFilter.FILTER_REJECT;
      }
      // Visit the children of every other element; only <br> matters itself.
      return tag === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  let pendingSpace = false;
  let previousBlock: Element | null = null;

  function appendSpace(): void {
    // An unmapped character: a paragraph break is between nodes, not in one.
    if (text.length > 0 && !text.endsWith(' ')) text += ' ';
    pendingSpace = false;
  }

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== Node.TEXT_NODE) {
      pendingSpace = true; // <br>
      continue;
    }

    const textNode = node as Text;
    const data = textNode.data;
    if (data.length === 0) continue;

    const block = closestBlock(textNode);
    if (previousBlock !== null && block !== previousBlock) pendingSpace = true;
    previousBlock = block;

    let index = 0;
    while (index < data.length) {
      if (isWhitespace(data[index] as string)) {
        let run = index;
        while (run < data.length && isWhitespace(data[run] as string)) run += 1;
        // One space stands for the whole run, mapped to its first character
        // so that a highlight ending here still covers something.
        if (text.length > 0 && !text.endsWith(' ')) {
          segments.push({ node: textNode, nodeOffset: index, textOffset: text.length, length: 1 });
          text += ' ';
        }
        pendingSpace = false;
        index = run;
        continue;
      }

      if (pendingSpace) appendSpace();
      let run = index;
      while (run < data.length && !isWhitespace(data[run] as string)) run += 1;
      segments.push({
        node: textNode,
        nodeOffset: index,
        textOffset: text.length,
        length: run - index,
      });
      text += data.slice(index, run);
      index = run;
    }
  }

  return { text, segments };
}

/**
 * The offset in the index for one DOM point.
 *
 * Boundaries that fall between characters -- an element container, a
 * skipped subtree, collapsed whitespace -- resolve outwards: a `start`
 * moves to the next character, an `end` to the previous one, so the
 * selection never grows into text the user did not pick.
 */
function pointOffset(
  index: TextIndex, container: Node, offset: number, side: 'start' | 'end',
): number | null {
  const { segments } = index;
  if (segments.length === 0) return null;

  const point = (container.ownerDocument ?? document).createRange();
  try {
    point.setStart(container, offset);
    point.collapse(true);
  } catch {
    return null;
  }

  let low = 0;
  let high = segments.length;
  try {
    while (low < high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle] as TextSegment;
      if (point.comparePoint(segment.node, segment.nodeOffset) < 0) low = middle + 1;
      else high = middle;
    }
  } catch {
    return null;
  }

  const previous = low > 0 ? (segments[low - 1] as TextSegment) : null;
  if (previous && previous.node === container && offset > previous.nodeOffset) {
    return previous.textOffset + Math.min(offset - previous.nodeOffset, previous.length);
  }
  if (side === 'end') return previous ? previous.textOffset + previous.length : 0;
  return low < segments.length ? (segments[low] as TextSegment).textOffset : index.text.length;
}

/**
 * Where a Range sits in the index, or null if it covers no text.
 *
 * Selecting a paragraph usually takes the markup's own newlines with it, so
 * the edges are trimmed: a stored quote never begins or ends with a space,
 * which is also what keeps it matchable on a page whose markup has been
 * reflowed since.
 */
export function offsetsFromRange(index: TextIndex, range: Range): TextPositionSelector | null {
  let start = pointOffset(index, range.startContainer, range.startOffset, 'start');
  let end = pointOffset(index, range.endContainer, range.endOffset, 'end');
  if (start === null || end === null) return null;
  while (start < end && index.text[start] === ' ') start += 1;
  while (end > start && index.text[end - 1] === ' ') end -= 1;
  return end > start ? { start, end } : null;
}

/**
 * Everything we store about where a highlight goes: the quote, the text
 * around it, and the offsets. `source` should be the normalized page URL,
 * so it matches the stored page record.
 */
export function targetFromRange(
  index: TextIndex, range: Range, source: string,
): AnnotationTarget | null {
  const position = offsetsFromRange(index, range);
  if (!position) return null;
  return { source, quote: quoteAt(index.text, position), position };
}

/** Index of the first segment that reaches past `offset`. */
function firstSegmentAfter(segments: TextSegment[], offset: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle] as TextSegment;
    if (segment.textOffset + segment.length <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The text node slices covered by an offset range, in document order.
 *
 * One highlight usually becomes several pieces: a sentence with a link in
 * it spans three text nodes, and each is wrapped separately so no element
 * boundary is crossed. Runs that sit next to each other in the same text
 * node are merged, so an ordinary sentence is one span and not one per
 * word.
 */
export function piecesFromOffsets(index: TextIndex, start: number, end: number): TextPiece[] {
  const pieces: TextPiece[] = [];
  const { segments } = index;
  for (let i = firstSegmentAfter(segments, start); i < segments.length; i += 1) {
    const segment = segments[i] as TextSegment;
    if (segment.textOffset >= end) break;
    const from = Math.max(start, segment.textOffset);
    const to = Math.min(end, segment.textOffset + segment.length);
    if (to <= from) continue;
    const piece = {
      node: segment.node,
      start: segment.nodeOffset + (from - segment.textOffset),
      end: segment.nodeOffset + (to - segment.textOffset),
    };
    const previous = pieces[pieces.length - 1];
    if (previous && previous.node === piece.node && previous.end === piece.start) {
      previous.end = piece.end;
    } else {
      pieces.push(piece);
    }
  }
  return pieces;
}
