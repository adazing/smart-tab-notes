# Smart Tab Notes API

Base URL (local dev): `http://localhost:8000`

All bodies are JSON. CORS allows the extension ids listed in `EXTENSION_IDS` in `backend/.env` (find yours at `chrome://extensions`), plus any origins in `ALLOWED_ORIGINS`. While `EXTENSION_IDS` is empty, any Chrome extension is allowed and the server logs a warning: fine for local development, not for a deployed backend.

## GET /health

Liveness check.

**Response 200**

```json
{ "status": "ok" }
```

## POST /explain

Explains a highlighted passage in plain language (2 to 4 sentences), using the current page and, when helpful, other open tabs.

**Request**

| Field | Type | Required | Notes |
|---|---|---|---|
| `selected_text` | string | yes | The highlighted text. 1 to 20,000 characters. Matched in the page ignoring case and whitespace, so a selection across paragraphs is found. Only the first ~600 tokens are sent to the model. |
| `page_text` | string | no | Readable text of the current page, up to 1,000,000 characters. The backend trims it to a window of at most 1,500 tokens around the selection. |
| `other_tabs` | array of Tab | no | Up to 20 other open tabs. Tabs with empty `text` are ignored. |

**Tab**

| Field | Type | Notes |
|---|---|---|
| `tab_id` | integer | Chrome tab id |
| `title` | string | Up to 1,000 characters. |
| `url` | string | Up to 4,096 characters. |
| `text` | string | Up to 300,000 characters. Readable text of the tab. The backend keeps the most relevant tabs and trims each to fit a token budget. |

```json
{
  "selected_text": "backpropagation",
  "page_text": "… Networks are trained with backpropagation and gradient descent …",
  "other_tabs": [
    { "tab_id": 7, "title": "Gradient descent", "url": "https://example.com/gd", "text": "Gradient descent updates weights …" }
  ]
}
```

**Response 200**

| Field | Type | Notes |
|---|---|---|
| `explanation` | string | Plain-language explanation, 2 to 4 sentences. |
| `used_tab_ids` | integer[] | Ids from `other_tabs` that the explanation drew on, in order of first use. Empty if only the current page was used. |

```json
{
  "explanation": "Backpropagation is how a neural network learns from its mistakes. It works out how much each weight contributed to the error so gradient descent can adjust it.",
  "used_tab_ids": [7]
}
```

**Errors**

| Status | When | Body |
|---|---|---|
| 422 | Invalid body: missing or empty `selected_text`, or any field over its size limit | FastAPI validation error |
| 503 | Backend has no OpenAI key configured | `{ "detail": "OPENAI_API_KEY is not set. Add it to backend/.env." }` |
| 502 | The LLM call or anything else on the server failed | `{ "detail": "The explanation service failed. Try again." }` |

**Example**

```bash
curl -s http://localhost:8000/explain \
  -H 'Content-Type: application/json' \
  -d '{"selected_text":"backpropagation","page_text":"Networks are trained with backpropagation.","other_tabs":[{"tab_id":7,"title":"Gradient descent","url":"https://example.com/gd","text":"Gradient descent updates weights to reduce error."}]}'
```

## POST /chat

Answers a question using only the tabs the user picked, citing the chunk each point came from. The answer is **streamed** as [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

**Request**

| Field | Type | Required | Notes |
|---|---|---|---|
| `messages` | array of Message | yes | The conversation so far, oldest first, at most 50, each up to 20,000 characters. The last one must be from the user. The last 10 are sent to the model, trimmed. |
| `tabs` | array of ChatTab | yes | 1 to 20 tabs the user chose; at most 1,500 chunks and 3,000,000 characters of chunk text in total. |

**Message**: `{ "role": "user" \| "assistant", "content": string }`

**ChatTab**

| Field | Type | Notes |
|---|---|---|
| `tab_id` | integer | Chrome tab id |
| `title` | string | Up to 1,000 characters. |
| `url` | string | Up to 4,096 characters. |
| `chunks` | array of `{ id, heading, text }` | At least one. Exactly the `chunks` from the extension's `getTabContext` (`id` and `heading` and `text` of each `TextChunk`). `id` must match `[A-Za-z0-9_.:-]{1,64}` and be unique across all tabs, which `t<tabId>-c<n>` ids are. Chunk `text` up to 10,000 characters. |

```json
{
  "messages": [{ "role": "user", "content": "How does backpropagation use the chain rule?" }],
  "tabs": [
    {
      "tab_id": 101,
      "title": "Backpropagation",
      "url": "https://en.wikipedia.org/wiki/Backpropagation",
      "chunks": [{ "id": "t101-c1", "heading": "Overview", "text": "Backpropagation computes the gradient …" }]
    }
  ]
}
```

**Response**: `200`, `Content-Type: text/event-stream`. Events, in order:

| Event | Data | When |
|---|---|---|
| `token` | `{ "text": string }` | Many times: the next piece of the answer. Append them in order. |
| `done` | see below | Once, last, on success. |
| `error` | `{ "detail": string }` | Once, last, if anything fails. It can be the **first** event (for example if retrieval fails), so don't assume a `token` came first. Show `detail`. |

```text
event: token
data: {"text": "Backpropagation applies the chain rule "}

event: token
data: {"text": "layer by layer [t101-c1]."}

event: done
data: {"answer": "…", "citations": [...], "used_tab_ids": [101], "covered": true, "usage": {...}, "timing": {...}}
```

**Citations in the text.** The answer cites chunks inline as `[chunk_id]`, for example `[t101-c1]`, after the sentence or bullet that uses them; a point may cite several (`[t101-c1][t102-c4]`). They arrive inside `token` events, so render them as you go: a `[…]` whose contents is a chunk id you sent is a citation (others, like a stray `[1]`, are plain text). The `done` event's `citations` gives each one a chip number.

**`done` data**

| Field | Type | Notes |
|---|---|---|
| `answer` | string | The full answer, markers included. Same as the `token` texts joined. |
| `citations` | array of Citation | Each cited chunk once, in order of first use. Chunk ids the server never sent to the model are dropped. |
| `used_tab_ids` | integer[] | Tabs cited, in order of first use. |
| `covered` | boolean | `false` when nothing was cited: the answer then says "Your selected tabs don't cover this." and what they do cover. |
| `usage` | object | `{ embedding_tokens, prompt_tokens, completion_tokens, total_tokens }` for this request. |
| `timing` | object | `{ first_token_ms, total_ms }`, measured on the server. |

**Citation**: `{ "n": 1, "chunk_id": "t101-c1", "tab_id": 101, "title": "Backpropagation", "url": "https://…", "heading": "Overview" }`. `n` is the chip number: show `[t101-c1]` as chip **1**, and clicking it switches to `tab_id`.

**How chunks are chosen.** If all chunks fit in about 3,500 tokens they are all sent. Otherwise the question (plus the previous question, for short follow-ups like "and why?") and every chunk are embedded with `text-embedding-3-small`, and up to 8 chunks that fit are sent: first each tab's best chunk (if it scores at least 75% of the best chunk overall, so every relevant tab is represented), then the most similar of the rest. Chunk embeddings are cached in memory, so later turns in the same chat only embed the new question.

**Errors before streaming starts** (normal JSON responses):

| Status | When |
|---|---|
| 422 | Invalid body: no messages, last message not from the user, no tabs, a tab with no chunks, a bad or duplicate chunk id, or anything over its size limit. |
| 503 | Backend has no OpenAI key configured. |

**Example**

```bash
curl -N http://localhost:8000/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"What does gradient descent do?"}],"tabs":[{"tab_id":7,"title":"Gradient descent","url":"https://example.com/gd","chunks":[{"id":"t7-c0","heading":"Intro","text":"Gradient descent nudges weights downhill to reduce the loss."}]}]}'
```

## POST /rank-tabs

Scores how relevant each open tab is to a question, so the side panel can suggest tabs to include. Uses embeddings only (no chat model), so it is fast and cheap.

**Request**

| Field | Type | Required | Notes |
|---|---|---|---|
| `question` | string | yes | The question being typed, up to 2,000 characters. |
| `tabs` | array of `{ tab_id, title, url, snippet }` | yes | 1 to 100 tabs. `snippet` (up to 4,000 characters) is any short text from the tab, such as its first chunk; title and snippet are scored together. |

**Response 200**

```json
{
  "scores": [
    { "tab_id": 2, "score": 0.61, "suggested": true },
    { "tab_id": 3, "score": 0.42, "suggested": true },
    { "tab_id": 1, "score": 0.08, "suggested": false }
  ]
}
```

| Field | Notes |
|---|---|
| `scores` | One per tab, highest `score` first. |
| `score` | Cosine similarity between the question and the tab, roughly 0 to 1. |
| `suggested` | `score >= RANK_SUGGEST_THRESHOLD` (default 0.3). The panel should still include the current tab by default and let the user confirm. The threshold has not been calibrated against real questions yet. |

**Errors**: 422 invalid body or over a size limit, 503 no OpenAI key, 502 the embedding call failed.

## Token logging

Every `/explain`, `/chat` and `/rank-tabs` request logs the tokens it used to the server console. The format looks like this (illustrative numbers, not a measurement):

```text
INFO:     /chat tokens: embedding_tokens=6812 prompt_tokens=3420 completion_tokens=96 total_tokens=10328 tabs=3 sources=8 retrieval=embeddings first_token_ms=1450 total_ms=3020
```

`/chat` also returns the same numbers in its `done` event. Requests that fail or are abandoned still log what they used. If the client disconnects mid-answer, generation stops within about a token. Answers are capped at 700 tokens, and OpenAI calls time out after 30 seconds.
