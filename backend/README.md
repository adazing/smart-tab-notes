# Smart Tab Notes backend

FastAPI service with a LangGraph explain agent. API shapes live in [docs/api.md](../docs/api.md).

## Setup

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
cd backend
uv sync
cp .env.example .env   # then put your OpenAI key in .env
uv run uvicorn app.main:app --reload --port 8000
```

`.env` is gitignored. Never put an API key in code, in docs, or in the extension.

## Tests

```bash
uv run pytest
```

The LLM call is mocked, so tests don't need a key.

## Explain agent

`app/agents/explain.py` is a three-node LangGraph graph:

1. **build_context**: trims the page text to a window around the selection (`PAGE_TOKEN_BUDGET`, default 1500 tokens), ranks the other tabs by keyword overlap with the selection, and keeps the best ones within `TABS_TOKEN_BUDGET` (default 2000; at most `PER_TAB_TOKEN_BUDGET`, default 600, per tab).
2. **llm_node**: asks the model (`OPENAI_MODEL`, default `gpt-4o-mini`) for a plain-language 2 to 4 sentence explanation, tagging sentences that use another tab with `[tab:ID]`.
3. **cite_node**: collects those tags into `used_tab_ids` (only ids that were actually sent), then removes them from the text.

To mock the model, patch `app.agents.explain.call_llm`.

## Chat agent

`app/agents/chat.py` (`POST /chat`, streamed) is another three-node graph:

1. **retrieve_node**: sends every chunk when they all fit in `CHAT_CONTEXT_TOKENS` (default 3500). Otherwise embeds the question and the chunks (`EMBEDDING_MODEL`, default `text-embedding-3-small`, cached in memory) and keeps the `CHAT_TOP_K` (default 8) most similar chunks that fit.
2. **answer_node**: streams an answer that uses only those chunks and cites each point as `[chunk_id]`, or says the tabs don't cover the question. Tokens go out through LangGraph's custom stream (`get_stream_writer`).
3. **cite_node**: turns the markers into numbered citations with `tab_id`, title, url and heading, and sets `covered`.

`POST /rank-tabs` scores tabs against a question with the same embeddings.

All OpenAI calls are in `app/llm.py` (`complete`, `stream_chat`, `embed_texts`); tests replace those with fakes. Every request logs its token usage.

### Live check with 3 sample pages

`samples/tabs.json` holds three real pages (Wikipedia's Backpropagation and Gradient descent, and the Python tutorial's Classes page), chunked by the extension's own extractor. With the server running and a working key:

```bash
uv run python scripts/chat_smoke.py
```

It asks a one-tab question, a two-tab question and an unrelated one, and prints each streamed answer with its time to first word (target: under 3 seconds), citations and tokens.
