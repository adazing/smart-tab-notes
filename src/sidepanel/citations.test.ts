import { describe, expect, it } from 'vitest';
import { splitCitations, type Citation } from './citations';
import { SseParser } from '../shared/sse';

const sent = new Set(['t1-c0', 't1-c1', 't2-c0']);
const cite = (n: number, chunk_id: string, tab_id = 1): Citation => ({ n, chunk_id, tab_id, title: 'T', url: 'https://x/', heading: '' });

describe('splitCitations', () => {
  it('numbers sent chunk ids in order of first use and leaves other brackets as text', () => {
    expect(splitCitations('A [t2-c0]. B [1] [t1-c0][t2-c0].', sent, null)).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'cite', chunkId: 't2-c0', n: 1 },
      { kind: 'text', text: '. B [1] ' },
      { kind: 'cite', chunkId: 't1-c0', n: 2 },
      { kind: 'cite', chunkId: 't2-c0', n: 1 },
      { kind: 'text', text: '.' },
    ]);
  });

  it('uses the server numbers once done, and removes markers it dropped', () => {
    const segments = splitCitations('A [t1-c1]. B [t2-c0].', sent, [cite(1, 't2-c0', 2)]);
    expect(segments).toEqual([
      { kind: 'text', text: 'A. B ' },
      { kind: 'cite', chunkId: 't2-c0', n: 1 },
      { kind: 'text', text: '.' },
    ]);
  });

  it('hides a half-arrived marker while streaming', () => {
    expect(splitCitations('Answer [t1-c', sent, null, true)).toEqual([{ kind: 'text', text: 'Answer ' }]);
    expect(splitCitations('Answer [t1-c', sent, null, false)).toEqual([{ kind: 'text', text: 'Answer [t1-c' }]);
  });
});

describe('SseParser', () => {
  it('parses events split across chunks with any line ending', () => {
    const parser = new SseParser();
    const events = [
      ...parser.push('event: token\r\ndata: {"text": "Hel'),
      ...parser.push('lo"}\r'),
      ...parser.push('\n\r\n: comment\nevent: done\ndata: {"a":1}\n'),
      ...parser.push('data: {"b":2}\n\n'),
    ];
    expect(events).toEqual([
      { event: 'token', data: '{"text": "Hello"}' },
      { event: 'done', data: '{"a":1}\n{"b":2}' },
    ]);
  });

  it('flushes a final event with no blank line at the end', () => {
    const parser = new SseParser();
    expect(parser.push('event: error\ndata: {"detail":"x"}')).toEqual([]);
    expect(parser.end()).toEqual([{ event: 'error', data: '{"detail":"x"}' }]);
  });
});
