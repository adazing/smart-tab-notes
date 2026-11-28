"""Recap agent: build_context -> llm_node -> parse_node.

Used by `POST /recap` when a reader reopens a page they have notes on: it
turns their highlights, their own notes and the summaries of chats they had
about the page into a short reminder of what they learned there.

build_context  renders each note as a small block and fills a token budget
               with them, oldest first, then does the same for the chat
               summaries. A note too long for one block is trimmed.
llm_node       asks the model for a short paragraph followed by bullets.
parse_node     splits that answer into `recap` (the paragraph) and `points`
               (the bullets), so the side panel does not parse prose.

Nothing here invents content: with no notes and no summaries the request is
rejected by the schema, so the model always has something real to work from.
"""

from __future__ import annotations

import re
from typing import TypedDict

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

from app.agents.explain import count_tokens, truncate_tokens
from app.config import get_settings


class RecapState(TypedDict, total=False):
    # inputs
    title: str
    url: str
    # Each note: text (the highlight), note, question, explanation.
    notes: list[dict[str, str]]
    chat_summaries: list[str]
    # build_context
    note_blocks: list[str]
    summary_blocks: list[str]
    # llm_node
    raw_answer: str
    # parse_node
    recap: str
    points: list[str]


def _quote(label: str, value: str) -> str:
    return f'{label}: "{value.strip()}"'


def note_block(index: int, note: dict[str, str], budget: int) -> str:
    """One note as a few labelled lines, trimmed to `budget` tokens."""
    lines = [f"Note {index}:", _quote("Highlighted", note.get("text", ""))]
    if note.get("note", "").strip():
        lines.append(_quote("What they wrote", note["note"]))
    if note.get("question", "").strip():
        lines.append(_quote("What they asked", note["question"]))
    if note.get("explanation", "").strip():
        label = "Answer they got" if note.get("question", "").strip() else "Explanation they saved"
        lines.append(_quote(label, note["explanation"]))
    return truncate_tokens("\n".join(lines), budget)


def build_context(state: RecapState) -> RecapState:
    """Fill the budgets with notes, then with chat summaries, oldest first."""
    settings = get_settings()

    remaining = settings.recap_notes_token_budget
    note_blocks: list[str] = []
    for index, note in enumerate(state.get("notes", []), start=1):
        if remaining <= 20:
            break
        block = note_block(index, note, min(settings.recap_per_note_token_budget, remaining))
        remaining -= count_tokens(block)
        note_blocks.append(block)

    remaining = settings.recap_summaries_token_budget
    summary_blocks: list[str] = []
    for index, summary in enumerate(state.get("chat_summaries", []), start=1):
        if remaining <= 20:
            break
        block = truncate_tokens(f"Chat {index}: {summary.strip()}", min(settings.recap_per_note_token_budget, remaining))
        remaining -= count_tokens(block)
        summary_blocks.append(block)

    return {"note_blocks": note_blocks, "summary_blocks": summary_blocks}


SYSTEM_PROMPT = """You remind a reader what they learned on a web page they are opening again.

You are given the passages they highlighted, the notes they wrote in their own \
words, any question they asked and the answer they saved, and summaries of chats \
they had about the page.

Write the recap as:
- first a paragraph of 2 to 4 sentences: what this page covered and what they took \
from it, in plain language, addressed to them as "you";
- then up to 5 bullets, one per line, each starting with "- ", one for each thing \
they marked, in the order given, one short sentence each.

Use only what you are given. Never add facts of your own, and never guess what a \
highlight was about: if a note says little, say little. Keep the reader's own \
wording where they wrote something. No headings, no bold, no other formatting."""


def build_messages(state: RecapState) -> list[BaseMessage]:
    parts = [f"Page: {state.get('title') or '(untitled)'} ({state.get('url') or 'unknown URL'})"]
    if state.get("note_blocks"):
        parts.append("What they marked on the page:\n\n" + "\n\n".join(state["note_blocks"]))
    if state.get("summary_blocks"):
        parts.append("Chats they had about this page:\n\n" + "\n".join(state["summary_blocks"]))
    return [SystemMessage(SYSTEM_PROMPT), HumanMessage("\n\n".join(parts))]


def call_llm(messages: list[BaseMessage]) -> str:
    """Single seam for the model call so tests can mock it. Logs tokens used."""
    from app import llm

    usage = llm.Usage()
    try:
        return llm.complete(messages, usage)
    finally:
        usage.log("/recap")  # also when the call fails


def llm_node(state: RecapState) -> RecapState:
    return {"raw_answer": call_llm(build_messages(state))}


_BULLET = re.compile(r"^(?:[-*•–]|\d+[.)])\s+(.+)$")
# Models sometimes label the parts anyway; drop a leading "Recap:" or "Points:".
_LABEL = re.compile(r"^(recap|summary|points|highlights|what you learned)\s*:\s*", re.IGNORECASE)

MAX_POINTS = 5


def parse_recap(raw: str) -> tuple[str, list[str]]:
    """Split the answer into its paragraph and its bullets.

    Prose after the first bullet is dropped rather than folded into the
    paragraph: it is usually a sign-off ("Happy reading!"), and a recap the
    reader did not ask for should not grow one.
    """
    prose: list[str] = []
    points: list[str] = []
    for line in raw.splitlines():
        stripped = _LABEL.sub("", line.strip()).strip()
        if not stripped:
            continue
        bullet = _BULLET.match(stripped)
        if bullet:
            point = bullet.group(1).strip()
            if point:
                points.append(point)
        elif not points:
            prose.append(stripped)
    return " ".join(prose).strip(), points[:MAX_POINTS]


def parse_node(state: RecapState) -> RecapState:
    recap, points = parse_recap(state.get("raw_answer", ""))
    return {"recap": recap, "points": points}


def build_graph():
    graph = StateGraph(RecapState)
    graph.add_node("build_context", build_context)
    graph.add_node("llm_node", llm_node)
    graph.add_node("parse_node", parse_node)
    graph.add_edge(START, "build_context")
    graph.add_edge("build_context", "llm_node")
    graph.add_edge("llm_node", "parse_node")
    graph.add_edge("parse_node", END)
    return graph.compile()


recap_graph = build_graph()
