import json
import re
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import llm
from app.agents.chat import build_query
from app.config import get_settings
from app.main import app

client = TestClient(app)
SAMPLES = json.loads((Path(__file__).parent.parent / "samples" / "tabs.json").read_text())


def fake_embed(texts, usage):
    """Bag-of-words vectors: texts sharing words point the same way."""
    vectors = []
    for text in texts:
        vector = [0.0] * 256
        for word in re.findall(r"[a-z]{3,}", text.lower()):
            vector[zlib.crc32(word.encode()) % 256] += 1.0
        vectors.append(vector)
        usage.embedding_tokens += len(text.split())
    return vectors


class FakeChat:
    """Streams a scripted answer and remembers the prompt it was given."""

    def __init__(self, answer):
        self.answer = answer  # a string, or a function of the system prompt
        self.prompts = []

    def __call__(self, messages, usage, cancel=None):
        self.prompts.append(messages)
        usage.add_chat({"input_tokens": 1200, "output_tokens": 45})
        answer = self.answer(messages[0].content) if callable(self.answer) else self.answer
        for word in re.split(r"(?<= )", answer):
            yield word


@pytest.fixture(autouse=True)
def no_key_needed(monkeypatch):
    monkeypatch.setattr(llm, "require_key", lambda: "test-key")
    monkeypatch.setattr(llm, "embed_texts", fake_embed)


def sse(response) -> list[tuple[str, dict]]:
    events = []
    for block in response.text.strip().split("\n\n"):
        name = re.search(r"^event: (.+)$", block, re.M).group(1)
        data = json.loads(re.search(r"^data: (.+)$", block, re.M).group(1))
        events.append((name, data))
    return events


TABS = [
    {
        "tab_id": 7,
        "title": "Gradient descent",
        "url": "https://example.com/gd",
        "chunks": [{"id": "t7-c0", "heading": "Intro", "text": "Gradient descent nudges weights downhill."}],
    },
    {
        "tab_id": 9,
        "title": "Backpropagation",
        "url": "https://example.com/bp",
        "chunks": [
            {"id": "t9-c0", "heading": "Overview", "text": "Backpropagation computes gradients layer by layer."},
            {"id": "t9-c1", "heading": "History", "text": "It was popularised in 1986."},
        ],
    },
]


def chat(answer: str, messages=None, tabs=TABS, monkeypatch=None):
    fake = FakeChat(answer)
    monkeypatch.setattr(llm, "stream_chat", fake)
    response = client.post(
        "/chat",
        json={"messages": messages or [{"role": "user", "content": "How do networks learn?"}], "tabs": tabs},
    )
    return response, fake


def test_streams_tokens_then_done_with_numbered_citations(monkeypatch):
    answer = (
        "Backpropagation computes the gradients [t9-c0]. "
        "Gradient descent then uses them to update weights [t7-c0][t9-c0]. "
        "Ignored markers: [1] [t999-c0]."
    )
    response, fake = chat(answer, monkeypatch=monkeypatch)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = sse(response)
    tokens = [data["text"] for name, data in events if name == "token"]
    assert len(tokens) > 5 and "".join(tokens) == answer
    name, done = events[-1]
    assert name == "done"
    assert done["answer"] == answer
    assert [(c["n"], c["chunk_id"], c["tab_id"]) for c in done["citations"]] == [(1, "t9-c0", 9), (2, "t7-c0", 7)]
    assert done["citations"][0] | {} == {
        "n": 1,
        "chunk_id": "t9-c0",
        "tab_id": 9,
        "title": "Backpropagation",
        "url": "https://example.com/bp",
        "heading": "Overview",
    }
    assert done["used_tab_ids"] == [9, 7]
    assert done["covered"] is True
    assert done["usage"] == {"embedding_tokens": 0, "prompt_tokens": 1200, "completion_tokens": 45, "total_tokens": 1245}
    assert done["timing"]["first_token_ms"] is not None

    # Small tabs fit the budget whole, so every chunk is sent and nothing is embedded.
    system = fake.prompts[0][0].content
    for chunk_id in ("t7-c0", "t9-c0", "t9-c1"):
        assert f"[{chunk_id}]" in system
    assert "Use only the sources" in system


def test_says_so_when_tabs_do_not_cover_the_question(monkeypatch):
    response, _ = chat(
        "Your selected tabs don't cover this. They cover gradient descent and backpropagation.",
        messages=[{"role": "user", "content": "What is the capital of France?"}],
        monkeypatch=monkeypatch,
    )
    done = sse(response)[-1][1]
    assert done["covered"] is False
    assert done["citations"] == []
    assert done["used_tab_ids"] == []


def test_retrieves_only_relevant_chunks_from_three_real_pages(monkeypatch):
    # backend/samples/tabs.json: Backpropagation, Gradient descent, Python classes (71 chunks).
    question = "How does backpropagation use the chain rule to compute the gradient of the loss?"
    def answer(system: str) -> str:
        first_sent = re.search(r"^\[(t101-c\d+)\]", system, re.M).group(1)
        not_sent = next(f"t101-c{i}" for i in range(30) if f"[t101-c{i}]" not in system)
        return f"It applies the chain rule layer by layer [{first_sent}]. Also [{not_sent}]."

    response, fake = chat(
        answer,
        messages=[{"role": "user", "content": question}],
        tabs=SAMPLES,
        monkeypatch=monkeypatch,
    )
    done = sse(response)[-1][1]
    system = fake.prompts[0][0].content
    sent = re.findall(r"^\[(t\d+-c\d+)\]", system, re.M)

    settings = get_settings()
    assert 0 < len(sent) <= settings.chat_top_k
    assert sum(chunk_id.startswith("t101-") for chunk_id in sent) > len(sent) / 2
    # The word-overlap fake scores every page alike, so the Python page may get
    # its one guaranteed slot; real embeddings leave it out (checked live).
    assert sum(chunk_id.startswith("t103-") for chunk_id in sent) <= 1
    assert done["usage"]["embedding_tokens"] > 0
    # The cited chunk that was sent is kept; the one that wasn't is dropped.
    first_backprop = next(chunk_id for chunk_id in sent if chunk_id.startswith("t101-"))
    assert [(c["chunk_id"], c["tab_id"]) for c in done["citations"]] == [(first_backprop, 101)]


def test_sends_conversation_history_and_uses_it_for_short_follow_ups(monkeypatch):
    messages = [
        {"role": "user", "content": "How does gradient descent choose the step size?"},
        {"role": "assistant", "content": "It uses a learning rate [t7-c0]."},
        {"role": "user", "content": "and why?"},
    ]
    _, fake = chat("Because [t7-c0].", messages=messages, monkeypatch=monkeypatch)
    prompt = fake.prompts[0]
    assert [type(m).__name__ for m in prompt] == ["SystemMessage", "HumanMessage", "AIMessage", "HumanMessage"]
    assert build_query(messages) == "How does gradient descent choose the step size?\nand why?"


def test_model_failure_mid_stream_sends_an_error_event(monkeypatch):
    def broken(messages, usage, cancel=None):
        yield "Partial "
        raise RuntimeError("upstream timeout")

    monkeypatch.setattr(llm, "stream_chat", broken)
    response = client.post("/chat", json={"messages": [{"role": "user", "content": "hi"}], "tabs": TABS})
    events = sse(response)
    assert events[0] == ("token", {"text": "Partial "})
    assert events[-1] == ("error", {"detail": "The chat service failed. Try again."})


@pytest.mark.parametrize(
    "body",
    [
        {"messages": [{"role": "assistant", "content": "hi"}], "tabs": TABS},
        {"messages": [{"role": "user", "content": "hi"}], "tabs": []},
        {"messages": [], "tabs": TABS},
        {"messages": [{"role": "user", "content": "hi"}], "tabs": [TABS[0], TABS[0]]},  # duplicate chunk ids
        {"messages": [{"role": "user", "content": "hi"}], "tabs": [{**TABS[0], "chunks": [{"id": "bad id!", "text": "x"}]}]},
        {"messages": [{"role": "user", "content": "x" * 20_001}], "tabs": TABS},
        {"messages": [{"role": "user", "content": "hi"}] * 51, "tabs": TABS},
        {"messages": [{"role": "user", "content": "hi"}], "tabs": [{**TABS[0], "chunks": [{"id": "c", "text": "x" * 10_001}]}]},
        {  # too many chunks in total
            "messages": [{"role": "user", "content": "hi"}],
            "tabs": [{"tab_id": t, "chunks": [{"id": f"t{t}-c{i}", "text": "x"} for i in range(100)]} for t in range(16)],
        },
    ],
)
def test_rejects_bad_requests(body):
    assert client.post("/chat", json=body).status_code == 422


def test_missing_key_is_503_before_streaming(monkeypatch):
    def no_key():
        raise llm.MissingAPIKeyError("OPENAI_API_KEY is not set. Add it to backend/.env.")

    monkeypatch.setattr(llm, "require_key", no_key)
    response = client.post("/chat", json={"messages": [{"role": "user", "content": "hi"}], "tabs": TABS})
    assert response.status_code == 503
    rank = client.post("/rank-tabs", json={"question": "q", "tabs": [{"tab_id": 1, "snippet": "x"}]})
    assert rank.status_code == 503


def test_rank_tabs_scores_every_tab_highest_first():
    response = client.post(
        "/rank-tabs",
        json={
            "question": "how does backpropagation compute gradients",
            "tabs": [
                {"tab_id": 1, "title": "Banana bread", "snippet": "Mash ripe bananas with flour and sugar."},
                {"tab_id": 2, "title": "Backpropagation", "snippet": "Backpropagation computes gradients of the loss."},
                {"tab_id": 3, "title": "Gradient descent", "snippet": "Uses gradients to update weights."},
            ],
        },
    )
    assert response.status_code == 200
    scores = response.json()["scores"]
    assert [s["tab_id"] for s in scores] == [2, 3, 1]
    assert scores[0]["score"] > scores[1]["score"] > scores[2]["score"]
    assert scores[0]["suggested"] is True
    assert scores[2]["suggested"] is False


def test_rank_tabs_rejects_oversized_requests():
    assert client.post("/rank-tabs", json={"question": "q" * 2_001, "tabs": [{"tab_id": 1}]}).status_code == 422
    assert client.post("/rank-tabs", json={"question": "q", "tabs": [{"tab_id": 1, "snippet": "s" * 4_001}]}).status_code == 422


def test_long_history_is_trimmed_before_it_reaches_the_model(monkeypatch):
    from app.agents.explain import count_tokens

    messages = [{"role": "user" if i % 2 == 0 else "assistant", "content": "word " * 4000} for i in range(9)]
    _, fake = chat("Short answer [t7-c0].", messages=messages, monkeypatch=monkeypatch)
    prompt = fake.prompts[0]
    assert all(count_tokens(m.content) <= 1_000 for m in prompt[1:])
    assert count_tokens(prompt[-1].content) > 400  # the question itself keeps more room


def test_each_relevant_tab_gets_its_best_chunk_before_one_tab_takes_every_slot(monkeypatch):
    from app.agents.chat import retrieve_node

    monkeypatch.setattr(get_settings(), "chat_context_tokens", 400)  # ~8 of the 12 chunks fit
    # Score = the number after "score" in the chunk text; the question is [1, 0].
    def scored(texts, usage):
        out = [[1.0, 0.0]]
        for text in texts[1:]:
            score = float(re.search(r"score (\d\.\d+)", text).group(1))
            out.append([score, (1 - score**2) ** 0.5])
        return out

    monkeypatch.setattr(llm, "embed_texts", scored)
    tabs = [
        {"tab_id": 1, "title": "Long", "chunks": [{"id": f"t1-c{i}", "text": f"score 0.9{i} " + "x " * 40} for i in range(10)]},
        {"tab_id": 2, "title": "Short", "chunks": [{"id": "t2-c0", "text": "score 0.80 " + "x " * 40}]},
        {"tab_id": 3, "title": "Unrelated", "chunks": [{"id": "t3-c0", "text": "score 0.20 " + "x " * 40}]},
    ]
    out = retrieve_node({"messages": [{"role": "user", "content": "q"}], "tabs": tabs, "usage": llm.Usage()})
    ids = [s["chunk_id"] for s in out["sources"]]
    assert "t2-c0" in ids  # 0.80 >= 0.75 x 0.99: relevant enough to get a slot
    assert "t3-c0" not in ids  # 0.20 is not
    assert len(ids) == get_settings().chat_top_k


def test_prompt_lists_every_selected_tab(monkeypatch):
    _, fake = chat("Your selected tabs don't cover this.", monkeypatch=monkeypatch)
    system = fake.prompts[0][0].content
    assert "- Tab 7: Gradient descent" in system and "- Tab 9: Backpropagation" in system
