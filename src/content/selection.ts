export interface SelectionSnapshot {
  text: string;
  url: string;
  range: Range;
}

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function insideEditable(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return !!element?.closest(`${EDITABLE}, [data-smart-tab-notes]`);
}

/**
 * True when a range starts, ends or passes through an editable control (an
 * input, a textarea, a select, or a contenteditable region such as an email
 * draft). Text there is the user's own writing, so it is never shown or sent.
 */
export function touchesEditable(range: Range): boolean {
  if (insideEditable(range.startContainer) || insideEditable(range.endContainer)) return true;
  const ancestor = range.commonAncestorContainer;
  if (!(ancestor instanceof Element)) return false;
  return [...ancestor.querySelectorAll(EDITABLE)].some((control) => range.intersectsNode(control));
}

export function captureSelection(host: HTMLElement): SelectionSnapshot | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const text = selection.toString();
  if (!text.trim() || range.startContainer.getRootNode() === host.shadowRoot || touchesEditable(range)) return;
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
