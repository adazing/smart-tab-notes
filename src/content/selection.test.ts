// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { touchesEditable } from './selection';

function rangeOver(selector: string): Range {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(selector)!);
  return range;
}

describe('touchesEditable', () => {
  document.body.innerHTML = `
    <p id="plain">Ordinary article text.</p>
    <div id="draft" contenteditable="true"><p id="inside">My unsent email draft.</p></div>
    <div id="readonly" contenteditable="false"><p>Not editable.</p></div>
    <div id="around"><p>Before</p><textarea>secret</textarea><p>After</p></div>`;

  it('is false for ordinary page text', () => {
    expect(touchesEditable(rangeOver('#plain'))).toBe(false);
    expect(touchesEditable(rangeOver('#readonly'))).toBe(false);
  });

  it('is true inside a contenteditable region, such as an email draft', () => {
    expect(touchesEditable(rangeOver('#inside'))).toBe(true);
  });

  it('is true for a range that passes through a form control', () => {
    expect(touchesEditable(rangeOver('#around'))).toBe(true);
  });
});
