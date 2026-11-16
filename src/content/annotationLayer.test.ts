// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAnnotationLayer, type AnnotationLayer } from './annotationLayer';
import { HIGHLIGHT_ATTRIBUTE } from './highlightSpans';
import { buildTextIndex } from './textIndex';
import { quoteAt } from '../shared/anchor';
import type { Annotation } from '../shared/storage-types';

/** The layer's only way out is sendToBackground, so that is what we fake. */
const bus = vi.hoisted(() => {
  /** Handlers the layer registered with onMessage, by kind, so tests can deliver messages. */
  const handlers: Record<string, (payload: never) => unknown> = {};
  return {
    send: vi.fn(),
    handlers,
    on: vi.fn((_endpoint: string, kind: string, handler: (payload: never) => unknown) => {
      handlers[kind] = handler;
      return () => { if (handlers[kind] === handler) delete handlers[kind]; };
    }),
  };
});
vi.mock('../shared/messages', () => ({ sendToBackground: bus.send, onMessage: bus.on }));

const PAGE =
  '<h1>Attention</h1>' +
  '<p id="first">Transformers replaced <a href="/rnn">recurrent networks</a> entirely.</p>' +
  '<p id="second">The model scales quadratically with sequence length.</p>';

let layer: AnnotationLayer;
let stored: Annotation[];
let nextId = 0;

/** A note saved earlier against the text currently on the page. */
function savedNote(quote: string, extra: Partial<Annotation> = {}): Annotation {
  const index = buildTextIndex();
  const start = index.text.indexOf(quote);
  if (start < 0) throw new Error(`Not on the page: ${quote}`);
  const position = { start, end: start + quote.length };
  nextId += 1;
  return {
    id: `note-${nextId}`,
    pageId: 'page-1',
    text: quote,
    createdAt: 1_000,
    updatedAt: 1_000,
    deleted: false,
    target: { source: 'https://example.com/paper', quote: quoteAt(index.text, position), position },
    ...extra,
  };
}

function spans(id?: string): HTMLElement[] {
  const selector = id === undefined
    ? `[${HIGHLIGHT_ATTRIBUTE}]`
    : `[${HIGHLIGHT_ATTRIBUTE}="${id}"]`;
  return [...document.querySelectorAll<HTMLElement>(selector)];
}

function card(): HTMLElement {
  return document.getElementById('smart-tab-notes-annotations')!.shadowRoot!
    .querySelector<HTMLElement>('.card')!;
}

function click(label: string): void {
  const button = [...card().querySelectorAll('button')].find((element) => element.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}. Card shows: ${card().textContent}`);
  button.click();
}

/** Let the layer's messages resolve and its timers run. */
async function settle(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function sentPayloads(kind: string): unknown[] {
  return bus.send.mock.calls.filter((call) => call[0] === kind).map((call) => call[1]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', window.clearTimeout);
  document.body.innerHTML = PAGE;
  stored = [];
  nextId = 0;

  bus.send.mockImplementation(async (kind: string, payload: Record<string, string>) => {
    switch (kind) {
      case 'annotations:list':
        return { ok: true, data: { annotations: stored.filter((note) => !note.deleted) } };
      case 'annotations:save': {
        nextId += 1;
        const annotation = {
          id: `saved-${nextId}`, pageId: 'page-1', createdAt: 2_000, updatedAt: 2_000,
          deleted: false, ...payload,
        } as unknown as Annotation;
        stored.push(annotation);
        return { ok: true, data: { ok: true, annotation } };
      }
      case 'annotations:update': {
        const existing = stored.find((note) => note.id === payload.id);
        if (!existing) return { ok: true, data: { ok: false, reason: 'This note no longer exists.' } };
        if (payload.note !== undefined) existing.note = payload.note === '' ? undefined : payload.note;
        if (payload.explanation !== undefined) Object.assign(existing, { explanation: payload.explanation, sources: payload.sources });
        return { ok: true, data: { ok: true, annotation: { ...existing } } };
      }
      case 'annotations:delete': {
        const existing = stored.find((note) => note.id === payload.id);
        if (existing) existing.deleted = true;
        return { ok: true, data: { ok: existing !== undefined } };
      }
      default:
        return { ok: true, data: { ok: true } };
    }
  });
});

afterEach(() => {
  layer?.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('putting saved notes back on the page', () => {
  it('draws every note whose quote is still there, and leaves the text alone', async () => {
    stored = [savedNote('Transformers replaced recurrent networks entirely.'), savedNote('quadratically')];
    const before = document.body.textContent;

    layer = installAnnotationLayer();
    await settle();

    expect(sentPayloads('annotations:list')).toEqual([{ url: location.href }]);
    expect(spans('note-1')).toHaveLength(3);
    expect(spans('note-2')).toHaveLength(1);
    expect(document.body.textContent).toBe(before);
    expect(document.querySelector('a')!.getAttribute('href')).toBe('/rnn');
  });

  it('draws nothing and asks for nothing when the page has no saved notes', async () => {
    layer = installAnnotationLayer();
    await settle();
    expect(spans()).toEqual([]);
    expect(sentPayloads('annotations:anchorState')).toEqual([]);
  });

  it('finds a quote whose wording changed, and says so in the card', async () => {
    stored = [savedNote('The model scales quadratically with sequence length.')];
    document.querySelector('#second')!.textContent =
      'The model scales quadratically with the sequence length.';

    layer = installAnnotationLayer();
    await settle();

    const painted = spans('note-1');
    expect(painted).toHaveLength(1);
    expect(painted[0]!.textContent).toContain('with the sequence length');

    painted[0]!.dispatchEvent(new Event('mouseover', { bubbles: true }));
    expect(card().textContent).toContain('The page has changed here');
  });

  it('keeps a note whose text has gone, and marks it orphaned', async () => {
    stored = [savedNote('Transformers replaced recurrent networks entirely.')];
    document.querySelector('#first')!.textContent =
      'This article is about the migratory patterns of arctic terns.';

    layer = installAnnotationLayer();
    await settle();

    expect(spans()).toEqual([]);
    expect(sentPayloads('annotations:anchorState')).toEqual([{ id: 'note-1', orphaned: true }]);
    // The note itself was never deleted.
    expect(stored.filter((note) => !note.deleted)).toHaveLength(1);
  });

  it('does not report an anchoring result that storage already holds', async () => {
    stored = [savedNote('quadratically', { orphaned: false })];
    layer = installAnnotationLayer();
    await settle();

    expect(spans('note-1')).toHaveLength(1);
    expect(sentPayloads('annotations:anchorState')).toEqual([]);
  });

  it('places a note that only appears once the page has rendered', async () => {
    const index = buildTextIndex();
    const quote = 'Lazily rendered conclusion.';
    stored = [{
      id: 'note-late', pageId: 'page-1', text: quote, createdAt: 1, updatedAt: 1, deleted: false,
      target: {
        source: 'https://example.com/paper',
        quote: { exact: quote, prefix: '', suffix: '' },
        position: { start: index.text.length, end: index.text.length + quote.length },
      },
    }];

    layer = installAnnotationLayer();
    await settle();
    expect(spans()).toEqual([]);

    const late = document.createElement('p');
    late.textContent = quote;
    document.body.append(late);
    await settle();

    expect(spans('note-late')).toHaveLength(1);
    // Orphaned first, then placed: both results reach storage, in order.
    expect(sentPayloads('annotations:anchorState')).toEqual([
      { id: 'note-late', orphaned: true },
      { id: 'note-late', orphaned: false },
    ]);
  });

  it('puts the card back when the page takes its highlight away and it returns', async () => {
    stored = [savedNote('The model scales quadratically with sequence length.', { note: 'Kept' })];
    layer = installAnnotationLayer();
    await settle();
    spans('note-1')[0]!.click();
    expect(card().hidden).toBe(false);

    document.querySelector('#second')!.textContent =
      'The model scales quadratically with the sequence length.';
    await settle();

    expect(spans('note-1')).toHaveLength(1);
    expect(card().hidden).toBe(false);
    expect(card().textContent).toContain('Kept');
  });

  it('redraws a highlight the page has thrown away', async () => {
    stored = [savedNote('The model scales quadratically with sequence length.')];
    layer = installAnnotationLayer();
    await settle();
    expect(spans('note-1')).toHaveLength(1);

    // What editing the text in devtools does: the text node is replaced.
    document.querySelector('#second')!.textContent =
      'The model scales quadratically with the sequence length of the input.';
    await settle();

    const painted = spans('note-1');
    expect(painted).toHaveLength(1);
    expect(painted[0]!.textContent).toContain('quadratically');
  });
});

describe('the note card', () => {
  beforeEach(async () => {
    stored = [savedNote('quadratically', {
      note: 'Why squared?',
      explanation: 'Every token attends to every other token, so cost grows with the square.',
    })];
    layer = installAnnotationLayer();
    await settle();
  });

  it('shows the quote, the note and the explanation on hover, and hides again', async () => {
    expect(card().hidden).toBe(true);
    spans('note-1')[0]!.dispatchEvent(new Event('mouseover', { bubbles: true }));

    expect(card().hidden).toBe(false);
    expect(card().textContent).toContain('quadratically');
    expect(card().textContent).toContain('Why squared?');
    expect(card().textContent).toContain('Every token attends to every other token');

    document.querySelector('h1')!.dispatchEvent(new Event('mouseover', { bubbles: true }));
    await settle();
    expect(card().hidden).toBe(true);
  });

  it('opens on click, stays open, and closes on Escape', () => {
    spans('note-1')[0]!.click();
    expect(card().hidden).toBe(false);
    document.querySelector('h1')!.dispatchEvent(new Event('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(1_000);
    expect(card().hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(card().hidden).toBe(true);
  });

  it('stays open when the quote begins with something parked off screen', async () => {
    // Wikipedia's citation labels sit thousands of pixels above the page.
    stored = [savedNote('Transformers replaced recurrent networks entirely.')];
    layer = installAnnotationLayer();
    await settle();

    const painted = spans('note-2');
    expect(painted.length).toBeGreaterThan(1);
    vi.spyOn(painted[0]!, 'getBoundingClientRect')
      .mockReturnValue({ top: -120_000, bottom: -119_800, left: 0, right: 10 } as DOMRect);

    painted[0]!.dispatchEvent(new Event('mouseover', { bubbles: true }));
    expect(card().hidden).toBe(false);
    expect(card().textContent).toContain('Transformers replaced recurrent networks');
  });

  it('edits a note through storage and shows the saved text', async () => {
    spans('note-1')[0]!.click();
    click('Edit note');
    const field = card().querySelector('textarea')!;
    expect(field.value).toBe('Why squared?');

    field.value = 'Because of the attention matrix.';
    card().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(sentPayloads('annotations:update'))
      .toEqual([{ id: 'note-1', note: 'Because of the attention matrix.' }]);
    expect(card().textContent).toContain('Because of the attention matrix.');
    expect(card().querySelector('textarea')).toBeNull();
  });

  it('deletes a note, takes the highlight out, and restores the text', async () => {
    spans('note-1')[0]!.click();
    click('Delete');
    // Deleting asks once more, so a stray click can't lose a note.
    expect(bus.send).not.toHaveBeenCalledWith('annotations:delete', expect.anything());
    click('Really delete?');
    await settle();

    expect(sentPayloads('annotations:delete')).toEqual([{ id: 'note-1' }]);
    expect(spans()).toEqual([]);
    expect(document.querySelector('#second')!.innerHTML)
      .toBe('The model scales quadratically with sequence length.');
    expect(card().hidden).toBe(true);
  });

  it('says so when storage refuses an edit instead of looking saved', async () => {
    spans('note-1')[0]!.click();
    click('Edit note');
    stored = [];
    card().querySelector('textarea')!.value = 'Lost note';
    card().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(card().textContent).toContain('no longer exists');
  });
});

describe('saving a new highlight', () => {
  it('stores both selectors, draws the highlight, and says it was drawn', async () => {
    layer = installAnnotationLayer();
    await settle();

    const paragraph = document.querySelector('#second')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const result = await layer.save({ range, text: paragraph.textContent!, note: 'Mine' });
    await settle();

    expect(result).toEqual({ ok: true, drawn: true });
    const payload = sentPayloads('annotations:save')[0] as {
      url: string; title: string; text: string; note: string;
      target: { source: string; quote: { exact: string; prefix: string; suffix: string };
        position: { start: number; end: number } };
    };
    expect(payload.url).toBe(location.href);
    expect(payload.note).toBe('Mine');
    expect(payload.text).toBe('The model scales quadratically with sequence length.');
    expect(payload.target.quote.exact).toBe('The model scales quadratically with sequence length.');
    expect(payload.target.quote.prefix.endsWith('recurrent networks entirely. ')).toBe(true);
    expect(payload.target.quote.suffix).toBe('');
    expect(payload.target.position.end - payload.target.position.start)
      .toBe(payload.target.quote.exact.length);

    expect(spans('saved-1')).toHaveLength(1);
    expect(document.body.textContent).toContain('The model scales quadratically');
    // The card opens on the new highlight: that is the confirmation.
    expect(card().hidden).toBe(false);
    expect(card().textContent).toContain('Mine');
  });

  it('opens the card later when the page was still settling at save time', async () => {
    layer = installAnnotationLayer();
    await settle();

    const paragraph = document.querySelector('#second')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    // The page replaces the quoted text while the save is in flight, so the
    // first anchoring pass finds nothing.
    bus.send.mockImplementationOnce(async (_kind: string, payload: Record<string, string>) => {
      paragraph.textContent = 'Rendering...';
      const annotation = {
        id: 'saved-late', pageId: 'page-1', createdAt: 2_000, updatedAt: 2_000,
        deleted: false, ...payload,
      } as unknown as Annotation;
      stored.push(annotation);
      return { ok: true, data: { ok: true, annotation } };
    });
    const result = await layer.save({ range, text: paragraph.textContent! });
    expect(result).toEqual({ ok: true, drawn: false });
    expect(card().hidden).toBe(true);

    paragraph.textContent = 'The model scales quadratically with sequence length.';
    await settle();
    expect(spans('saved-late')).toHaveLength(1);
    expect(card().hidden).toBe(false);
  });

  it('reports a refusal from storage rather than drawing anything', async () => {
    layer = installAnnotationLayer();
    await settle();
    bus.send.mockResolvedValueOnce({ ok: true, data: { ok: false, reason: 'Pages must use HTTP(S).' } });

    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#first')!);
    const result = await layer.save({ range, text: 'Transformers' });

    expect(result).toEqual({ ok: false, reason: 'Pages must use HTTP(S).' });
    expect(spans()).toEqual([]);
  });
});

describe('notes are highlights', () => {
  function selectionOf(selector: string): Range {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector)!);
    return range;
  }

  it('saves an AI answer with the highlight and shows it, with its sources, in the card', async () => {
    layer = installAnnotationLayer();
    await settle();
    const paragraph = document.querySelector('#second')!;
    await layer.save({
      range: selectionOf('#second'), text: paragraph.textContent!,
      explanation: 'Cost grows with the square of the length.', question: 'Why slow?',
      sources: [{ title: 'Big O', url: 'https://example.com/big-o' }],
    });
    await settle();

    expect(sentPayloads('annotations:save')[0]).toMatchObject({
      explanation: 'Cost grows with the square of the length.', question: 'Why slow?',
      sources: [{ title: 'Big O', url: 'https://example.com/big-o' }],
    });
    // The card opens on the new highlight as the confirmation.
    expect(card().hidden).toBe(false);
    expect(card().textContent).toContain('Q: Why slow?');
    expect(card().textContent).toContain('Cost grows with the square');
    const link = card().querySelector('a')!;
    expect(link.textContent).toBe('Big O');
    expect(link.getAttribute('href')).toBe('https://example.com/big-o');
    // Already explained: no Explain button.
    expect([...card().querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Explain');
  });

  it('opens a plain highlight with its note box ready', async () => {
    layer = installAnnotationLayer();
    await settle();
    await layer.save({ range: selectionOf('#second'), text: 'The model scales', editNote: true });
    await settle();
    const field = card().querySelector('textarea')!;
    expect(field).not.toBeNull();
    expect(field.placeholder).toBe('Add a note (optional)');
  });

  it('explains a saved highlight from its card and stores the answer on it', async () => {
    stored = [savedNote('quadratically')];
    layer = installAnnotationLayer({ requireUserGesture: false });
    await settle();
    bus.send.mockImplementationOnce(async () => ({
      ok: true, data: { ok: true, explanation: 'Squared growth.', sources: [{ tabId: 3, title: 'Big O', url: 'https://example.com/big-o' }] },
    }));
    spans('note-1')[0]!.click();
    click('Explain');
    expect(card().textContent).toContain('Explaining…');
    await settle(10);

    expect(sentPayloads('explain:run')).toEqual([{ text: 'quadratically', url: location.href }]);
    expect(sentPayloads('annotations:update')).toEqual([{
      id: 'note-1', explanation: 'Squared growth.', sources: [{ title: 'Big O', url: 'https://example.com/big-o' }],
    }]);
    expect(card().textContent).toContain('Squared growth.');
  });

  it("ignores a page script clicking the card's Explain button", async () => {
    stored = [savedNote('quadratically')];
    layer = installAnnotationLayer();
    await settle();
    spans('note-1')[0]!.click();
    click('Explain');
    await settle(10);
    expect(sentPayloads('explain:run')).toEqual([]);
  });

  it("doesn't reopen a card closed with Escape until the pointer leaves the highlight", async () => {
    stored = [savedNote('quadratically')];
    layer = installAnnotationLayer();
    await settle();
    const span = spans('note-1')[0]!;
    const over = (target: Element) => target.dispatchEvent(new Event('mouseover', { bubbles: true }));
    over(span);
    expect(card().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card().hidden).toBe(true);
    over(span); // still resting on it
    expect(card().hidden).toBe(true);
    over(document.querySelector('h1')!);
    over(span); // came back
    expect(card().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    span.click(); // a click always opens
    expect(card().hidden).toBe(false);
  });

  it('only asks the side panel to show a note for a real click, not a scripted one', async () => {
    stored = [savedNote('quadratically')];
    layer = installAnnotationLayer();
    await settle();
    spans('note-1')[0]!.click(); // jsdom clicks are untrusted, like a page script's
    expect(card().hidden).toBe(false);
    expect(sentPayloads('annotations:focus')).toEqual([]);
  });

  it('shows a note edited elsewhere in a card that is already open', async () => {
    stored = [savedNote('quadratically', { note: 'Old text' })];
    layer = installAnnotationLayer();
    await settle();
    spans('note-1')[0]!.click();
    expect(card().textContent).toContain('Old text');
    stored[0]!.note = 'New text from the side panel';
    bus.handlers['annotations:changed']!({ url: location.href } as never);
    await settle(10);
    expect(card().textContent).toContain('New text from the side panel');
  });

  it('re-reads notes when they change elsewhere, and reveals one when the side panel asks', async () => {
    layer = installAnnotationLayer();
    await settle();
    expect(spans()).toEqual([]);

    stored = [savedNote('quadratically')];
    bus.handlers['annotations:changed']!({ url: location.href } as never);
    await settle();
    expect(spans('note-1')).toHaveLength(1);

    Element.prototype.scrollIntoView = vi.fn();
    expect(bus.handlers['annotations:reveal']!({ id: 'note-1' } as never)).toEqual({ ok: true });
    await settle(400);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(card().hidden).toBe(false);
    expect(bus.handlers['annotations:reveal']!({ id: 'missing' } as never)).toMatchObject({ ok: false });
  });
});

describe('lifecycle', () => {
  it('installs one host, and a second install replaces the first', async () => {
    stored = [savedNote('quadratically')];
    layer = installAnnotationLayer();
    await settle();

    layer = installAnnotationLayer();
    await settle();
    expect(document.querySelectorAll('#smart-tab-notes-annotations')).toHaveLength(1);
    expect(spans('note-1')).toHaveLength(1);
  });

  it('takes its highlights and its card out of the page on disposal', async () => {
    stored = [savedNote('quadratically')];
    const before = document.body.innerHTML;
    layer = installAnnotationLayer();
    await settle();
    expect(spans()).toHaveLength(1);

    layer.dispose();
    expect(document.getElementById('smart-tab-notes-annotations')).toBeNull();
    expect(spans()).toEqual([]);
    expect(document.body.innerHTML).toBe(before);
  });
});
