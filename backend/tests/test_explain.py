from fastapi.testclient import TestClient

from app.agents import explain as explain_agent
from app.main import app

client = TestClient(app)


def test_explain_returns_explanation_and_cited_tabs(monkeypatch):
    seen_messages = []

    def fake_llm(messages):
        seen_messages.append(messages)
        return (
            "Backpropagation is how a neural network learns from its mistakes. "
            "It works out how much each weight contributed to the error [tab:7]. "
            "Made-up citations are dropped [tab:999]."
        )

    monkeypatch.setattr(explain_agent, "call_llm", fake_llm)

    resp = client.post(
        "/explain",
        json={
            "selected_text": "backpropagation",
            "page_text": "Intro text. Networks are trained with backpropagation and gradient descent. More text.",
            "other_tabs": [
                {"tab_id": 7, "title": "Gradient descent", "url": "https://example.com/gd", "text": "Gradient descent updates weights."},
                {"tab_id": 8, "title": "Empty tab", "url": "https://example.com/empty", "text": ""},
            ],
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["used_tab_ids"] == [7]
    assert "[tab:" not in body["explanation"]
    assert body["explanation"].startswith("Backpropagation is how")

    # The prompt included the selection and the tab with text, not the empty one.
    prompt = seen_messages[0][-1].content
    assert "backpropagation" in prompt
    assert "[tab:7]" in prompt
    assert "[tab:8]" not in prompt


def test_health():
    assert client.get("/health").json() == {"status": "ok"}
