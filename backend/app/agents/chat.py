"""Multi-tab chat agent: retrieve_node -> answer_node -> cite_node.

retrieve_node  embeds the question and every chunk of the chosen tabs and keeps
               the most relevant ones within a token budget. When all chunks
               already fit, it skips embeddings entirely (faster first word).
answer_node    streams an answer that uses only those chunks, citing each point
               as [chunk_id], or says the tabs don't cover the question.
cite_node      turns the [chunk_id] markers into numbered citations with their
               tab_id, title, url and heading.

Streaming: answer_node sends each token through LangGraph's custom stream
(`get_stream_writer`), so callers use `chat_graph.stream(..., stream_mode=
["custom", "values"])`. See app.main for the SSE wrapper.
"""

from __future__ import annotations

import re
from typing import Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from app import llm
from app.agents.explain import count_tokens, truncate_tokens
from app.config import get_settings


class Source(TypedDict):
    chunk_id: str
    tab_id: int
    title: str
    url: str
    heading: str
    text: str
    score: float


class ChatState(TypedDict, total=False):
    # inputs
    messages: list[dict[str, str]]
    tabs: list[dict[str, Any]]
    usage: llm.Usage
    # retrieve_node
    question: str
    sources: list[Source]
    retrieval: str  # "all" (everything fit) or "embeddings"
    # answer_node
    answer: str
    # cite_node
    citations: list[dict[str, Any]]
    used_tab_ids: list[int]
    covered: bool


def build_query(messages: list[dict[str, str]]) -> str:
    """The text to retrieve with. Short follow-ups ("and why?") also carry the previous question."""
    user = [m["content"] for m in messages if m["role"] == "user"]
    question = user[-1]
    if len(question.split()) < 8 and len(user) > 1:
        return f"{user[-2]}\n{question}"
    return question


def _all_sources(tabs: list[dict[str, Any]]) -> list[Source]:
    return [
        {
            "chunk_id": chunk["id"],
            "tab_id": tab["tab_id"],
            "title": tab.get("title", ""),
            "url": tab.get("url", ""),
            "heading": chunk.get("heading", ""),
            "text": chunk["text"],
            "score": 0.0,
        }
        for tab in tabs
        for chunk in tab["chunks"]
    ]


def retrieve_node(state: ChatState) -> ChatState:
    settings = get_settings()
    question = build_query(state["messages"])
    sources = _all_sources(state["tabs"])
    sizes = [count_tokens(s["text"]) for s in sources]

    if sum(sizes) <= settings.chat_context_tokens:
        return {"question": question, "sources": sources, "retrieval": "all"}

    texts = [f"{s['title']} — {s['heading']}\n{s['text']}" for s in sources]
    vectors = llm.embed_texts([question, *texts], state["usage"])
    query, chunk_vectors = vectors[0], vectors[1:]
    for source, vector in zip(sources, chunk_vectors):
        source["score"] = round(llm.cosine(query, vector), 4)

    ranked = sorted(range(len(sources)), key=lambda i: sources[i]["score"], reverse=True)
    picked: list[int] = []
    used = 0
    for i in ranked:
        if len(picked) >= settings.chat_top_k:
            break
        if used + sizes[i] > settings.chat_context_tokens and picked:
            continue
        picked.append(i)
        used += sizes[i]

    # Present the picked chunks in page order, so neighbouring chunks read naturally.
    picked.sort()
    return {"question": question, "sources": [sources[i] for i in picked], "retrieval": "embeddings"}


SYSTEM_PROMPT = """You answer questions using only the sources below, which are \
excerpts from the user's open browser tabs.

Rules:
- Use only the sources. Do not add outside knowledge, even if you know the answer.
- After each sentence or bullet that uses a source, cite it with its id in square \
brackets, for example [t12-c3]. If a point uses two sources, cite both: [t12-c3][t15-c0]. \
Only use ids that appear below.
- If the sources don't answer the question, say "Your selected tabs don't cover this." \
and then, in one sentence, what they do cover. Cite nothing in that case.
- Be concise: a short paragraph or a few bullets."""


def build_messages(state: ChatState) -> list[BaseMessage]:
    sources = "\n\n---\n\n".join(
        f"[{s['chunk_id']}] Tab {s['tab_id']}: {s['title'][:200]}"
        + (f" — {s['heading'][:200]}" if s["heading"] else "")
        + f"\n{s['text']}"
        for s in state["sources"]
    )
    # Older turns are trimmed harder than the question being asked.
    history: list[BaseMessage] = []
    recent = state["messages"][-get_settings().chat_history_messages :]
    for i, message in enumerate(recent):
        budget = 1_000 if i == len(recent) - 1 else 400
        cls = HumanMessage if message["role"] == "user" else AIMessage
        history.append(cls(truncate_tokens(message["content"], budget)))
    return [SystemMessage(f"{SYSTEM_PROMPT}\n\nSources:\n\n{sources}"), *history]


def answer_node(state: ChatState) -> ChatState:
    write = get_stream_writer()
    parts: list[str] = []
    for token in llm.stream_chat(build_messages(state), state["usage"]):
        parts.append(token)
        write({"token": token})
    return {"answer": "".join(parts)}


_MARKER = re.compile(r"\[([A-Za-z0-9_.:-]{1,64})\]")


def cite_node(state: ChatState) -> ChatState:
    by_id = {s["chunk_id"]: s for s in state["sources"]}
    citations: list[dict[str, Any]] = []
    seen: set[str] = set()
    for match in _MARKER.finditer(state.get("answer", "")):
        chunk_id = match.group(1)
        source = by_id.get(chunk_id)
        if source is None or chunk_id in seen:
            continue  # e.g. a Wikipedia footnote like [1], or an id we never sent
        seen.add(chunk_id)
        citations.append(
            {
                "n": len(citations) + 1,
                "chunk_id": chunk_id,
                "tab_id": source["tab_id"],
                "title": source["title"],
                "url": source["url"],
                "heading": source["heading"],
            }
        )
    used_tab_ids: list[int] = []
    for citation in citations:
        if citation["tab_id"] not in used_tab_ids:
            used_tab_ids.append(citation["tab_id"])
    return {"citations": citations, "used_tab_ids": used_tab_ids, "covered": bool(citations)}


def build_graph():
    graph = StateGraph(ChatState)
    graph.add_node("retrieve_node", retrieve_node)
    graph.add_node("answer_node", answer_node)
    graph.add_node("cite_node", cite_node)
    graph.add_edge(START, "retrieve_node")
    graph.add_edge("retrieve_node", "answer_node")
    graph.add_edge("answer_node", "cite_node")
    graph.add_edge("cite_node", END)
    return graph.compile()


chat_graph = build_graph()


def rank_tabs(question: str, tabs: list[dict[str, Any]], usage: llm.Usage) -> list[dict[str, Any]]:
    """Relevance of each tab to `question`, highest first."""
    threshold = get_settings().rank_suggest_threshold
    texts = [f"{t.get('title', '')}\n{t.get('snippet', '')}" for t in tabs]
    vectors = llm.embed_texts([question, *texts], usage)
    scores = [
        {
            "tab_id": tab["tab_id"],
            "score": round(llm.cosine(vectors[0], vector), 4),
        }
        for tab, vector in zip(tabs, vectors[1:])
    ]
    for item in scores:
        item["suggested"] = item["score"] >= threshold
    return sorted(scores, key=lambda item: item["score"], reverse=True)
