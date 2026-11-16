/**
 * A stand-in for the Python backend that follows docs/api.md, with canned
 * answers and no OpenAI key. For UI work and the browser tests.
 *
 *   npm run mock-backend            # http://localhost:8000
 *   PORT=8100 npm run mock-backend
 *
 * Or import { startMockBackend } to run it inside a test.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}');
}

/** POST /explain: echoes the selection, cites the first other tab with text. */
function explain(body) {
  if (typeof body.selected_text !== 'string' || !body.selected_text.trim()) {
    return [422, { detail: [{ msg: 'selected_text is required' }] }];
  }
  const quote = body.selected_text.trim().split(/\s+/).slice(0, 8).join(' ');
  const tab = (body.other_tabs ?? []).find((t) => t.text?.trim());
  const lead = body.question
    ? `Mock answer to "${body.question}" about "${quote}".`
    : `Mock explanation of "${quote}".`;
  const explanation = tab ? `${lead} Your tab "${tab.title}" covers it too.` : `${lead} It uses only this page.`;
  return [200, { explanation, used_tab_ids: tab ? [tab.tab_id] : [] }];
}

const words = (text) => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));

/**
 * POST /chat: streams a canned answer citing each tab's best-matching chunk
 * (by shared words with the question), then `done`. A question containing
 * "fail" sends an `error` event instead.
 */
async function chat(body, _req, res, cors) {
  const messages = body.messages ?? [];
  const tabs = body.tabs ?? [];
  if (!messages.length || messages.at(-1).role !== 'user' || !tabs.length || tabs.some((t) => !t.chunks?.length)) {
    return [422, { detail: [{ msg: 'invalid chat request' }] }];
  }
  const question = messages.at(-1).content;
  const asked = words(question);
  const picks = tabs.map((tab) => {
    const scored = tab.chunks.map((chunk) => ({ chunk, score: [...words(chunk.text)].filter((w) => asked.has(w)).length }));
    scored.sort((a, b) => b.score - a.score);
    return { tab, chunk: scored[0].chunk, score: scored[0].score };
  }).filter((pick) => pick.score > 0);

  const lines = [`Mock answer to "${question}".`];
  for (const { tab, chunk } of picks) {
    lines.push(`${tab.title || tab.url} covers ${chunk.heading || 'this'} [${chunk.id}].`);
  }
  if (!picks.length) lines.push("Your selected tabs don't cover this.");
  const answer = lines.join(' ');
  const citations = picks.map(({ tab, chunk }, i) => ({
    n: i + 1, chunk_id: chunk.id, tab_id: tab.tab_id, title: tab.title, url: tab.url, heading: chunk.heading,
  }));

  res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  if (question.toLowerCase().includes('fail')) {
    event('error', { detail: 'The chat service failed. Try again.' });
    res.end();
    return undefined;
  }
  // Word by word, splitting markers across events like a real model can.
  for (const piece of answer.match(/\S+\s*/g) ?? []) {
    if (res.destroyed) return undefined; // client went away
    event('token', { text: piece });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  event('done', {
    answer, citations, used_tab_ids: [...new Set(citations.map((c) => c.tab_id))], covered: picks.length > 0,
    usage: { embedding_tokens: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    timing: { first_token_ms: 1, total_ms: 1 },
  });
  res.end();
  return undefined;
}

/** POST /rank-tabs: share of question words found in the title, url and snippet. */
function rankTabs(body) {
  const asked = words(body.question ?? '');
  if (!asked.size || !body.tabs?.length) return [422, { detail: [{ msg: 'invalid rank request' }] }];
  const scores = body.tabs.map((tab) => {
    const have = words(`${tab.title} ${tab.url} ${tab.snippet}`);
    const score = [...asked].filter((w) => have.has(w)).length / asked.size;
    return { tab_id: tab.tab_id, score: Math.round(score * 100) / 100, suggested: score >= 0.3 };
  });
  scores.sort((a, b) => b.score - a.score);
  return [200, { scores }];
}

export const routes = {
  'GET /health': () => [200, { status: 'ok' }],
  'POST /explain': explain,
  'POST /chat': chat,
  'POST /rank-tabs': rankTabs,
};

/**
 * Start the server. Resolves to { url, close, requests }; `requests` records
 * every { method, path, body } received, for tests to assert on.
 */
export function startMockBackend({ port = 8000, delayMs = 0 } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const handler = routes[`${req.method} ${path}`];
    if (!handler) { send(res, 404, { detail: 'Not Found' }, cors); return; }
    let body = {};
    try {
      if (req.method === 'POST') body = await readJson(req);
    } catch {
      send(res, 422, { detail: [{ msg: 'invalid JSON' }] }, cors);
      return;
    }
    requests.push({ method: req.method, path, body });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const result = await handler(body, req, res, cors);
    if (result) send(res, result[0], result[1], cors);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        requests,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8000);
  const { url } = await startMockBackend({ port, delayMs: Number(process.env.DELAY_MS ?? 400) });
  console.log(`[mock-backend] listening on ${url} (canned answers, no OpenAI key needed)`);
}
