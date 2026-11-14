"""Edge cases found in the week 1 code review."""

import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agents import explain as explain_agent
from app.agents.explain import build_context, cite_node, count_tokens, find_selection, window_around
from app.main import app

client = TestClient(app)
filler = " ".join(f"Filler sentence number {i} keeps the page long." for i in range(1500))  # ~13k tokens


def test_finds_a_selection_that_spans_paragraphs():
    # selection.toString() keeps the paragraph break; the page text may not match it exactly.
    page = filler + " Alpha paragraph ends here.\n\nBeta paragraph starts here. " + filler
    window = window_around(page, "Alpha paragraph ends here.\n\n\nBeta paragraph starts here.", 300)
    assert "Alpha paragraph ends here." in window and "Beta paragraph starts here." in window
    assert count_tokens(window) <= 302  # budget plus the two ellipses


def test_case_insensitive_match_is_not_shifted_by_characters_that_change_length():
    page = "İ" * 3000 + " Target phrase is here. " + "x " * 3000
    assert find_selection(page, "TARGET PHRASE") is not None
    assert "Target phrase" in window_around(page, "TARGET PHRASE", 200)


def test_window_stays_within_budget_when_density_varies():
    # English all around, very dense text (CJK) right at the selection.
    page = filler + " " + "语言模型" * 3000 + " SELECTED " + "语言模型" * 3000 + " " + filler
    window = window_around(page, "SELECTED", 1500)
    assert "SELECTED" in window
    assert count_tokens(window) <= 1502


def test_selection_longer_than_the_budget_is_cut_to_the_budget():
    page = filler + " " + "long selection words " * 2000 + filler
    window = window_around(page, "long selection words " * 2000, 500)
    assert count_tokens(window) <= 502


def test_build_context_caps_tabs_and_the_prompt_caps_long_titles(monkeypatch):
    prompts = []
    monkeypatch.setattr(explain_agent, "call_llm", lambda messages: prompts.append(messages) or "An answer.")
    resp = client.post(
        "/explain",
        json={
            "selected_text": "word " * 3000,
            "page_text": filler,
            "other_tabs": [{"tab_id": 1, "title": "T" * 900, "url": "https://e.com/" + "u" * 3000, "text": filler}],
        },
    )
    assert resp.status_code == 200
    prompt = prompts[0][-1].content
    assert count_tokens(prompt) < 600 + 1500 + 600 + 400  # selection + page + one tab + labels


@pytest.mark.parametrize(
    "body",
    [
        {"selected_text": "x" * 20_001},
        {"selected_text": "x", "page_text": "p" * 1_000_001},
        {"selected_text": "x", "other_tabs": [{"tab_id": i} for i in range(21)]},
        {"selected_text": "x", "other_tabs": [{"tab_id": 1, "title": "t" * 1_001}]},
        {"selected_text": "x", "other_tabs": [{"tab_id": 1, "text": "t" * 300_001}]},
    ],
)
def test_oversized_requests_are_rejected(body):
    assert client.post("/explain", json=body).status_code == 422


@pytest.mark.parametrize(
    "answer, expected",
    [
        ("A point [tab:7, tab:8].", [7, 8]),
        ("A point [tab:7,8].", [7, 8]),
        ("A point [Tab:7].", [7]),
        ("A point [tab 7].", [7]),
        ("A point [tabs: 8 and 7].", [8, 7]),
    ],
)
def test_parses_citation_variants_and_strips_them(answer, expected):
    state = {"raw_answer": answer, "tab_contexts": [{"tab_id": 7}, {"tab_id": 8}]}
    result = cite_node(state)
    assert result["used_tab_ids"] == expected
    assert result["explanation"] == "A point."


def test_only_a_missing_key_is_reported_as_503(monkeypatch):
    def broken(messages):
        raise RuntimeError("something else went wrong")

    monkeypatch.setattr(explain_agent, "call_llm", broken)
    resp = client.post("/explain", json={"selected_text": "x"})
    assert resp.status_code == 502
    assert "something else" not in resp.text


def test_cors_allows_extension_ids_but_not_arbitrary_origins():
    def preflight(origin):
        return client.options(
            "/explain",
            headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
        )

    assert preflight("chrome-extension://" + "a" * 32).status_code == 200
    assert preflight("chrome-extension://not-an-extension-id").status_code == 400
    assert preflight("https://evil.example").status_code == 400


def test_env_file_is_read_from_backend_whatever_the_working_directory(tmp_path):
    (tmp_path / ".env").write_text("OPENAI_MODEL=read-from-cwd\n")
    backend = Path(__file__).resolve().parent.parent
    out = subprocess.run(
        [sys.executable, "-c", "from app.config import Settings; print(Settings().openai_model)"],
        cwd=tmp_path,
        env={"PYTHONPATH": str(backend), "PATH": ""},
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.strip() != "read-from-cwd"


def test_api_key_never_appears_in_settings_repr(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-secret-value")
    settings = Settings()
    assert "sk-test-secret-value" not in repr(settings)
    assert "sk-test-secret-value" not in str(settings.model_dump())
    assert settings.openai_api_key.get_secret_value() == "sk-test-secret-value"
