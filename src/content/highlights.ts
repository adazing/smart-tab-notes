/** Non-destructive rectangles: no page styles, text wrapping, or DOM replacement.
 * Unlike CSS Custom Highlights these work without a document-level stylesheet.
 * Temporary ranges follow layout changes; persistence/anchoring is a later ticket.
 */
export function createHighlights(root: ShadowRoot): {
  add: (range: Range) => void; render: () => void; clear: () => void;
} {
  const ranges: Range[] = [];
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  root.append(layer);
  function render(): void {
    const nodes: HTMLElement[] = [];
    for (const range of ranges) {
      if (!range.startContainer.isConnected || !range.endContainer.isConnected) continue;
      for (const rect of range.getClientRects()) {
        if (rect.bottom < 0 || rect.top > innerHeight) continue;
        const mark = document.createElement('div');
        mark.className = 'highlight';
        Object.assign(mark.style, {
          left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        });
        nodes.push(mark);
      }
    }
    layer.replaceChildren(...nodes);
  }
  return {
    add(range) { ranges.push(range.cloneRange()); render(); },
    render,
    clear() { ranges.length = 0; layer.replaceChildren(); },
  };
}
