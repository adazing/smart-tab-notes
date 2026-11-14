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
