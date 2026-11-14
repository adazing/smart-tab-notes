export interface SelectionSnapshot {
  text: string;
  url: string;
  range: Range;
}

function excluded(node: Node, host: HTMLElement): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return node.getRootNode() === host.shadowRoot || !!element?.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-smart-tab-notes]',
  );
}

export function captureSelection(host: HTMLElement): SelectionSnapshot | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const text = selection.toString();
  if (!text.trim() || excluded(range.startContainer, host) || excluded(range.endContainer, host)) return;
  // Reject ranges crossing editable controls, even if neither endpoint is inside one.
  const ancestor = range.commonAncestorContainer;
  if (ancestor instanceof Element) {
    const controls = ancestor.querySelectorAll('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if ([...controls].some(control => range.intersectsNode(control))) return;
  }
  return { text, url: location.href, range: range.cloneRange() };
}

export interface Rectangle { left: number; right: number; top: number; bottom: number }

/** Fixed viewport coordinates, including the visual viewport on zoomed pages. */
export function toolbarPosition(
  rect: Rectangle, width: number, height: number,
  viewport: { width: number; height: number; left?: number; top?: number },
): { left: number; top: number } {
  const margin = 8;
  const minLeft = (viewport.left ?? 0) + margin;
  const minTop = (viewport.top ?? 0) + margin;
  const maxLeft = Math.max(minLeft, (viewport.left ?? 0) + viewport.width - width - margin);
  const maxTop = Math.max(minTop, (viewport.top ?? 0) + viewport.height - height - margin);
  const above = rect.top - height - margin;
  return {
    left: Math.max(minLeft, Math.min(maxLeft, (rect.left + rect.right - width) / 2)),
    top: Math.max(minTop, Math.min(maxTop, above >= minTop ? above : rect.bottom + margin)),
  };
}
