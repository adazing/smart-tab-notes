"""The OpenAI wrappers in app/llm.py, with the OpenAI clients faked."""

import os
import logging
import subprocess
import sys
import threading
import zlib
from array import array
from pathlib import Path

import pytest

from app import llm
from app.config import Settings, get_settings

BACKEND = Path(__file__).resolve().parent.parent


def minimal_env(**extra: str) -> dict[str, str]:
    """
    A deliberately bare environment for a child process: nothing on PATH, so
    the child cannot find anything by accident.

    SystemRoot is the exception. On Windows, importing asyncio loads the
    _overlapped extension, which starts Winsock, which needs SystemRoot to
    find its providers; without it the child dies on import. Passing it does
    not weaken the test: it says nothing about where the backend looks for
    its .env.
    """
    env = {"PATH": "", **extra}
    root = os.environ.get("SystemRoot")
    if root:
        env["SystemRoot"] = root
    return env

@pytest.fixture(autouse=True)
def fake_key(monkeypatch):
    monkeypatch.setattr(llm, "require_key", lambda: "test-key")


class FakeEmbeddings:
    calls: list[list[str]] = []
    last_kwargs: dict = {}

    def __init__(self, **kwargs):
        FakeEmbeddings.last_kwargs = kwargs

    def embed_documents(self, texts):
        FakeEmbeddings.calls.append(list(texts))
        return [[float(zlib.crc32(t.encode()) % 97), 1.0, 2.0] for t in texts]


@pytest.fixture
def fake_embeddings(monkeypatch):
    import langchain_openai

    FakeEmbeddings.calls = []
    monkeypatch.setattr(langchain_openai, "OpenAIEmbeddings", FakeEmbeddings)
    monkeypatch.setattr(llm, "_cache", llm.OrderedDict())
    return FakeEmbeddings


def test_cached_vectors_used_by_a_request_are_not_evicted_mid_request(monkeypatch, fake_embeddings):
    # A full cache, then one request that reuses old vectors and adds many new
    # ones. Previously the new ones evicted the old before they were returned
    # (KeyError, so /chat failed).
    monkeypatch.setattr(llm, "_CACHE_SIZE", 5)
    usage = llm.Usage()
    old = [f"old {i}" for i in range(5)]
    llm.embed_texts(old, usage)
    vectors = llm.embed_texts(old + [f"new {i}" for i in range(8)], usage)
    assert len(vectors) == 13
    assert len(llm._cache) == 5
    assert fake_embeddings.calls[-1] == [f"new {i}" for i in range(8)]  # old ones came from the cache


def test_cache_is_least_recently_used(monkeypatch, fake_embeddings):
    monkeypatch.setattr(llm, "_CACHE_SIZE", 2)
    usage = llm.Usage()
    llm.embed_texts(["a"], usage)
    llm.embed_texts(["b"], usage)
    llm.embed_texts(["a"], usage)  # a is now the most recently used
    llm.embed_texts(["c"], usage)  # evicts b, not a
    fake_embeddings.calls.clear()
    llm.embed_texts(["a"], usage)
    assert fake_embeddings.calls == []


def test_vectors_are_stored_compactly_and_only_new_texts_count(fake_embeddings):
    usage = llm.Usage()
    first = llm.embed_texts(["one two three"], usage)
    tokens = usage.embedding_tokens
    llm.embed_texts(["one two three"], usage)
    assert usage.embedding_tokens == tokens > 0
    assert isinstance(first[0], array) and first[0].typecode == "f"


def test_embedding_client_has_a_timeout_and_one_retry(fake_embeddings):
    llm.embed_texts(["x"], llm.Usage())
    assert FakeEmbeddings.last_kwargs["request_timeout"] == 30
    assert FakeEmbeddings.last_kwargs["max_retries"] == 1


def test_chat_client_has_a_timeout_one_retry_and_an_answer_cap():
    model = llm.chat_model()
    settings = get_settings()
    assert model.request_timeout == settings.openai_timeout_s == 30
    assert model.max_retries == 1
    assert model.max_tokens == settings.answer_max_tokens == 700


class FakeStream:
    def __init__(self, n):
        self.n = n
        self.sent = 0
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        if self.sent >= self.n:
            raise StopIteration
        self.sent += 1
        return type("Chunk", (), {"content": f"t{self.sent} ", "usage_metadata": None})()

    def close(self):
        self.closed = True


def test_cancel_stops_streaming_and_closes_the_openai_request(monkeypatch):
    stream = FakeStream(100)
    monkeypatch.setattr(llm, "chat_model", lambda streaming=False: type("M", (), {"stream": lambda self, m: stream})())
    cancel = threading.Event()
    got = []
    for token in llm.stream_chat([], llm.Usage(), cancel):
        got.append(token)
        if len(got) == 3:
            cancel.set()
    assert len(got) == 3
    assert stream.sent <= 4  # at most one more chunk read after cancelling
    assert stream.closed


def test_failed_explain_still_logs_tokens(monkeypatch, caplog):
    from app.agents import explain

    def boom(messages, usage):
        usage.prompt_tokens = 120
        raise RuntimeError("upstream failed")

    monkeypatch.setattr(llm, "complete", boom)
    with caplog.at_level(logging.INFO, logger="uvicorn.error"), pytest.raises(RuntimeError):
        explain.call_llm([])
    assert any("/explain tokens" in r.getMessage() and "prompt_tokens=120" in r.getMessage() for r in caplog.records)


def test_env_file_is_backend_dotenv():
    assert Path(Settings.model_config["env_file"]) == BACKEND / ".env"


def test_cors_with_extension_ids_set_allows_only_those():
    code = """
from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)
def ok(origin):
    r = c.options("/explain", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
    return r.status_code
print(ok("chrome-extension://" + "a" * 32), ok("chrome-extension://" + "b" * 32))
"""
    out = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND,
        env=minimal_env(PYTHONPATH=str(BACKEND), EXTENSION_IDS="a" * 32),
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.split() == ["200", "400"]
