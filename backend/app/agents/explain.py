"""Explain agent: build_context -> llm_node -> cite_node.

The LLM is asked to tag sentences that use another tab with [tab:ID]. cite_node
collects those markers (keeping only ids that were actually sent as context),
returns them as used_tab_ids, and strips them from the explanation text.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import TypedDict

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

from app.config import get_settings

# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------


@lru_cache
def _encoder():
    try:
        import tiktoken

        return tiktoken.get_encoding("o200k_base")
    except Exception:  # offline or tiktoken unavailable: fall back to estimate
        return None


def count_tokens(text: str) -> int:
    enc = _encoder()
    return len(enc.encode(text)) if enc else (len(text) + 3) // 4


def truncate_tokens(text: str, budget: int) -> str:
    if budget <= 0:
        return ""
    enc = _encoder()
    if enc:
        ids = enc.encode(text)
        return text if len(ids) <= budget else enc.decode(ids[:budget])
    return text[: budget * 4]


def window_around(text: str, selection: str, budget: int) -> str:
    """Trim `text` to ~`budget` tokens centred on the first occurrence of `selection`."""
    if count_tokens(text) <= budget:
        return text
    idx = text.find(selection)
    if idx < 0:
        idx = text.lower().find(selection.lower())
    if idx < 0:
        return truncate_tokens(text, budget)

    # Pick a character window centred on the selection, sized from the text's
    # actual chars-per-token ratio so it lands close to the token budget.
    chars_per_token = len(text) / max(1, count_tokens(text))
    chars = max(len(selection), int(budget * chars_per_token))
    centre = idx + len(selection) // 2
    start = max(0, centre - chars // 2)
    end = min(len(text), start + chars)
    start = max(0, end - chars)
    snippet = text[start:end]
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return f"{prefix}{snippet}{suffix}"


_WORD = re.compile(r"[a-z0-9]{3,}")


def _keywords(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------


class TabContext(TypedDict):
    tab_id: int
    title: str
    url: str
    text: str


class ExplainState(TypedDict, total=False):
    # inputs
    selected_text: str
    page_text: str
    other_tabs: list[TabContext]
    # build_context
    page_context: str
    tab_contexts: list[TabContext]
    # llm_node
    raw_answer: str
    # cite_node
    explanation: str
    used_tab_ids: list[int]


def build_context(state: ExplainState) -> ExplainState:
    settings = get_settings()
    selection = state["selected_text"]
    page_context = window_around(state.get("page_text", ""), selection, settings.page_token_budget)

    # Rank other tabs by keyword overlap with the selection + surrounding page text,
    # then fill the tabs budget with the most relevant ones.
    query = _keywords(selection) | _keywords(page_context)
    tabs = [t for t in state.get("other_tabs", []) if t.get("text", "").strip()]
    tabs.sort(key=lambda t: len(query & _keywords(t["title"] + " " + t["text"])), reverse=True)

    remaining = settings.tabs_token_budget
    tab_contexts: list[TabContext] = []
    for tab in tabs:
        if remaining <= 50:
            break
        text = truncate_tokens(tab["text"], min(settings.per_tab_token_budget, remaining))
        remaining -= count_tokens(text)
        tab_contexts.append({**tab, "text": text})

    return {"page_context": page_context, "tab_contexts": tab_contexts}


SYSTEM_PROMPT = """You explain highlighted text from a web page to a curious reader.
Explain the highlighted text in plain language in 2 to 4 sentences. Avoid jargon; \
if you must use a term, define it.
Use the surrounding page text for context. You may also use the other open tabs \
when they genuinely help. When a sentence draws on another tab, end that sentence \
with its marker, e.g. [tab:42]. Never invent tab markers, and do not mark sentences \
that only use the current page."""


def build_messages(state: ExplainState) -> list[BaseMessage]:
    parts = [
        f"Highlighted text:\n\"\"\"{state['selected_text']}\"\"\"",
        f"Current page (around the highlight):\n\"\"\"{state.get('page_context') or '(none)'}\"\"\"",
    ]
    if state.get("tab_contexts"):
        tabs = "\n\n".join(
            f"[tab:{t['tab_id']}] {t['title']} ({t['url']})\n{t['text']}" for t in state["tab_contexts"]
        )
        parts.append(f"Other open tabs:\n{tabs}")
    return [SystemMessage(SYSTEM_PROMPT), HumanMessage("\n\n".join(parts))]


def call_llm(messages: list[BaseMessage]) -> str:
    """Single seam for the model call so tests can mock it."""
    from langchain_openai import ChatOpenAI

    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set. Add it to backend/.env.")
    llm = ChatOpenAI(model=settings.openai_model, api_key=settings.openai_api_key, temperature=0.2)
    return str(llm.invoke(messages).content)


def llm_node(state: ExplainState) -> ExplainState:
    return {"raw_answer": call_llm(build_messages(state))}


_TAB_MARKER = re.compile(r"\s*\[tab:\s*(\d+)\s*\]")


def cite_node(state: ExplainState) -> ExplainState:
    raw = state.get("raw_answer", "")
    allowed = {t["tab_id"] for t in state.get("tab_contexts", [])}
    used: list[int] = []
    for match in _TAB_MARKER.finditer(raw):
        tab_id = int(match.group(1))
        if tab_id in allowed and tab_id not in used:
            used.append(tab_id)
    explanation = re.sub(r"\s+([.,;:!?])", r"\1", _TAB_MARKER.sub("", raw)).strip()
    return {"explanation": explanation, "used_tab_ids": used}


def build_graph():
    graph = StateGraph(ExplainState)
    graph.add_node("build_context", build_context)
    graph.add_node("llm_node", llm_node)
    graph.add_node("cite_node", cite_node)
    graph.add_edge(START, "build_context")
    graph.add_edge("build_context", "llm_node")
    graph.add_edge("llm_node", "cite_node")
    graph.add_edge("cite_node", END)
    return graph.compile()


explain_graph = build_graph()
