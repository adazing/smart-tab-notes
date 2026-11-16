/**
 * Minimal Server-Sent Events parser for fetch() streams (EventSource can't
 * POST). Handles `event:` and `data:` fields, multi-line data, comments and
 * \n, \r\n or \r line endings, across arbitrary chunk boundaries.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  /** Feed decoded text; returns the events it completed. */
  push(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    // A trailing \r might be the first half of \r\n: wait for the next chunk.
    let match: RegExpExecArray | null;
    const lineEnd = /\r\n|\n|\r(?!$)/g;
    let start = 0;
    while ((match = lineEnd.exec(this.buffer)) !== null) {
      this.line(this.buffer.slice(start, match.index), events);
      start = match.index + match[0].length;
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  /** Call at end of stream: flushes an event not followed by a blank line. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ''), events);
    this.buffer = '';
    this.line('', events);
    return events;
  }

  private line(line: string, events: SseEvent[]): void {
    if (line === '') {
      if (this.data.length) events.push({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

/** Read a fetch body as SSE events. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* parser.push(value);
    }
    yield* parser.end();
  } finally {
    reader.releaseLock();
  }
}
