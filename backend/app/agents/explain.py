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


def find_selection(text: str, selection: str) -> tuple[int, int] | None:
    """Where `selection` occurs in `text`, ignoring case and whitespace differences.

    A selection spanning paragraphs arrives with newlines while the page text
    may join them differently, so match word by word with any whitespace in
    between. Long selections are matched on their first 40 words.
    """
    words = selection.split()
    if not words:
        return None
    for probe in (words[:40], words[:8]):
        pattern = r"\s+".join(re.escape(word) for word in probe)
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            end = match.end() if len(probe) == len(words) else min(len(text), match.start() + len(selection))
            return match.start(), end
    return None


def window_around(text: str, selection: str, budget: int) -> str:
    """Trim `text` to at most `budget` tokens, centred on `selection`."""
    if count_tokens(text) <= budget:
        return text
    span = find_selection(text, selection)
    if span is None:
        return truncate_tokens(text, budget)
    sel_start, sel_end = span
    if count_tokens(text[sel_start:sel_end]) >= budget:
        return "…" + truncate_tokens(text[sel_start:], budget) + "…"

    # Start from the page's average chars-per-token, then shrink until the
    # window really fits: token density varies (code, CJK, URLs).
    chars = int(budget * len(text) / max(1, count_tokens(text)))
    centre = (sel_start + sel_end) // 2
    for _ in range(6):
        chars = max(chars, sel_end - sel_start)
        start = max(0, min(sel_start, centre - chars // 2))
        end = min(len(text), max(sel_end, start + chars))
        start = max(0, min(start, end - chars))
        snippet = text[start:end]
        used = count_tokens(snippet)
        if used <= budget:
            break
        chars = int(chars * budget / used * 0.95)
    else:
        snippet = truncate_tokens(snippet, budget)
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
    selected = truncate_tokens(state["selected_text"], get_settings().selection_token_budget)
    parts = [
        f"Highlighted text:\n\"\"\"{selected}\"\"\"",
        f"Current page (around the highlight):\n\"\"\"{state.get('page_context') or '(none)'}\"\"\"",
    ]
    if state.get("tab_contexts"):
        tabs = "\n\n".join(
            f"[tab:{t['tab_id']}] {t['title'][:200]} ({t['url'][:300]})\n{t['text']}" for t in state["tab_contexts"]
        )
        parts.append(f"Other open tabs:\n{tabs}")
    return [SystemMessage(SYSTEM_PROMPT), HumanMessage("\n\n".join(parts))]


def call_llm(messages: list[BaseMessage]) -> str:
    """Single seam for the model call so tests can mock it. Logs tokens used."""
    from app import llm

    usage = llm.Usage()
    text = llm.complete(messages, usage)
    usage.log("/explain")
    return text


def llm_node(state: ExplainState) -> ExplainState:
    return {"raw_answer": call_llm(build_messages(state))}


# [tab:7], plus the variants models drift into: [Tab 7], [tab:7, tab:8], [tabs: 7, 8].
_TAB_MARKER = re.compile(
    r"\s*\[\s*tabs?\s*[:#]?\s*(\d+(?:(?:\s*[,;&]\s*(?:and\s+)?|\s+and\s+)(?:tabs?\s*[:#]?\s*)?\d+)*)\s*\]",
    re.IGNORECASE,
)


def cite_node(state: ExplainState) -> ExplainState:
    raw = state.get("raw_answer", "")
    allowed = {t["tab_id"] for t in state.get("tab_contexts", [])}
    used: list[int] = []
    for match in _TAB_MARKER.finditer(raw):
        for number in re.findall(r"\d+", match.group(1)):
            tab_id = int(number)
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
