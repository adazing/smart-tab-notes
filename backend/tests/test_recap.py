import pytest
from fastapi.testclient import TestClient

from app import llm
from app.agents import recap as recap_agent
from app.agents.recap import build_context, parse_recap
from app.main import app

client = TestClient(app)

NOTES = [
    {
        "text": "Transformers replaced recurrent networks entirely",
        "note": "this is the bit I keep forgetting",
        "question": "",
        "explanation": "",
    },
    {
        "text": "scales quadratically with sequence length",
        "note": "",
        "question": "Why is that a problem?",
        "explanation": "Twice the words means four times the work.",
    },
]

ANSWER = (
    "You read about attention here. You marked two passages and asked why long "
    "documents cost so much.\n\n"
    "- Transformers took over from recurrent networks, the bit you keep forgetting.\n"
    "- Attention scales quadratically, so twice the words means four times the work.\n"
)


def test_recap_returns_a_paragraph_and_points(monkeypatch):
    seen = []

    def fake_llm(messages):
        seen.append(messages)
        return ANSWER

    monkeypatch.setattr(recap_agent, "call_llm", fake_llm)

    resp = client.post(
        "/recap",
        json={
            "title": "Attention is all you need",
            "url": "https://example.com/attention",
            "notes": NOTES,
            "chat_summaries": ["You compared attention with convolutions."],
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["recap"].startswith("You read about attention here.")
    assert body["points"] == [
        "Transformers took over from recurrent networks, the bit you keep forgetting.",
        "Attention scales quadratically, so twice the words means four times the work.",
    ]

    # The prompt carried the page, both notes and the chat summary.
    prompt = seen[0][-1].content
    assert "Attention is all you need" in prompt
    assert "Transformers replaced recurrent networks" in prompt
    assert "this is the bit I keep forgetting" in prompt
    assert "Why is that a problem?" in prompt
    assert "You compared attention with convolutions." in prompt


def test_recap_needs_at_least_one_note_or_summary():
    resp = client.post("/recap", json={"title": "Empty", "notes": [], "chat_summaries": []})
    assert resp.status_code == 422


def test_recap_rejects_oversized_fields():
    resp = client.post("/recap", json={"notes": [{"text": "x" * 20_001}]})
    assert resp.status_code == 422
    resp = client.post("/recap", json={"notes": [{"text": ""}]})
    assert resp.status_code == 422


def test_recap_without_a_key_is_503(monkeypatch):
    def no_key(messages):
        raise llm.MissingAPIKeyError("OPENAI_API_KEY is not set. Add it to backend/.env.")

    monkeypatch.setattr(recap_agent, "call_llm", no_key)
    resp = client.post("/recap", json={"notes": [{"text": "something"}]})
    assert resp.status_code == 503
    assert "OPENAI_API_KEY" in resp.json()["detail"]


def test_recap_llm_failure_is_502(monkeypatch):
    def boom(messages):
        raise RuntimeError("the model fell over")

    monkeypatch.setattr(recap_agent, "call_llm", boom)
    resp = client.post("/recap", json={"notes": [{"text": "something"}]})
    assert resp.status_code == 502
    assert resp.json()["detail"] == "The recap service failed. Try again."


@pytest.mark.parametrize(
    "raw, expected_recap, expected_points",
    [
        # Bullets in the shapes models drift into, and labels they add.
        ("Recap: You learned things.\n* first\n2. second\n• third", "You learned things.", ["first", "second", "third"]),
        # Prose after the bullets is a sign-off, not part of the recap.
        ("The paragraph.\n- a point\nHappy reading!", "The paragraph.", ["a point"]),
        # No bullets at all is still a recap.
        ("Just a paragraph about what you read.", "Just a paragraph about what you read.", []),
        # At most five points.
        ("P\n- 1\n- 2\n- 3\n- 4\n- 5\n- 6", "P", ["1", "2", "3", "4", "5"]),
        ("", "", []),
    ],
)
def test_parse_recap(raw, expected_recap, expected_points):
    assert parse_recap(raw) == (expected_recap, expected_points)


def test_build_context_trims_to_the_budgets(monkeypatch):
    from app import config

    settings = config.get_settings()
    monkeypatch.setattr(settings, "recap_notes_token_budget", 60, raising=False)
    monkeypatch.setattr(settings, "recap_per_note_token_budget", 30, raising=False)
    monkeypatch.setattr(settings, "recap_summaries_token_budget", 30, raising=False)

    long_notes = [{"text": "word " * 400, "note": "", "question": "", "explanation": ""} for _ in range(10)]
    state = build_context({
        "title": "t", "url": "u", "notes": long_notes,
        "chat_summaries": ["summary " * 200, "second " * 200, "third " * 200],
    })

    # Every block fits its own budget, and the blocks together fit the total.
    assert 0 < len(state["note_blocks"]) < len(long_notes)
    assert all(recap_agent.count_tokens(block) <= 30 for block in state["note_blocks"])
    assert recap_agent.count_tokens("\n".join(state["note_blocks"])) <= 90
    assert 0 < len(state["summary_blocks"]) < 3


def test_build_context_keeps_what_the_reader_added():
    state = build_context({"title": "t", "url": "u", "notes": NOTES, "chat_summaries": []})
    blocks = "\n\n".join(state["note_blocks"])
    assert "Note 1:" in blocks and "Note 2:" in blocks
    assert "What they wrote" in blocks
    assert "What they asked" in blocks
    assert "Answer they got" in blocks
    # A note with no note, question or explanation gets only its highlight.
    plain = build_context({"notes": [{"text": "just a highlight"}], "chat_summaries": []})
    assert plain["note_blocks"] == ['Note 1:\nHighlighted: "just a highlight"']
