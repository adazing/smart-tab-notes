"""The only places the backend calls OpenAI, plus token accounting.

Agents call these through the module (`from app import llm; llm.embed_texts(...)`)
so tests can replace them with fakes: `monkeypatch.setattr(llm, "embed_texts", fake)`.
"""

from __future__ import annotations

import hashlib
import logging
import math
import threading
from collections import OrderedDict
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass

from langchain_core.messages import BaseMessage

from app.config import get_settings

logger = logging.getLogger("uvicorn.error")


@dataclass
class Usage:
    """Tokens used by one request. Logged, and returned to the client on /chat."""

    embedding_tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.embedding_tokens + self.prompt_tokens + self.completion_tokens

    def add_chat(self, metadata: dict | None) -> None:
        if metadata:
            self.prompt_tokens += int(metadata.get("input_tokens", 0))
            self.completion_tokens += int(metadata.get("output_tokens", 0))

    def as_dict(self) -> dict[str, int]:
        return {**asdict(self), "total_tokens": self.total_tokens}

    def log(self, endpoint: str, **extra: object) -> None:
        details = " ".join(f"{k}={v}" for k, v in {**self.as_dict(), **extra}.items())
        logger.info("%s tokens: %s", endpoint, details)


class MissingAPIKeyError(RuntimeError):
    """The backend has no OpenAI key configured (returned as 503)."""


def require_key() -> str:
    key = get_settings().openai_api_key.get_secret_value()
    if not key:
        raise MissingAPIKeyError("OPENAI_API_KEY is not set. Add it to backend/.env.")
    return key


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------


def chat_model(streaming: bool = False):
    from langchain_openai import ChatOpenAI

    settings = get_settings()
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=require_key(),
        temperature=0.2,
        streaming=streaming,
        stream_usage=True,
    )


def complete(messages: list[BaseMessage], usage: Usage) -> str:
    """One full reply."""
    response = chat_model().invoke(messages)
    usage.add_chat(getattr(response, "usage_metadata", None))
    return str(response.content)


def stream_chat(messages: list[BaseMessage], usage: Usage) -> Iterator[str]:
    """Yield the reply token by token; fills in `usage` when the stream ends."""
    for chunk in chat_model(streaming=True).stream(messages):
        usage.add_chat(getattr(chunk, "usage_metadata", None))
        if chunk.content:
            yield str(chunk.content)


# ---------------------------------------------------------------------------
# Embeddings
# ---------------------------------------------------------------------------

# Chunks of the same tab are re-sent on every chat turn, so cache their vectors.
_CACHE_SIZE = 5000
_EMBED_BATCH = 12
_cache: OrderedDict[str, list[float]] = OrderedDict()
_cache_lock = threading.Lock()


def _key(text: str) -> str:
    return hashlib.sha256(f"{get_settings().embedding_model}\n{text}".encode()).hexdigest()


def embed_texts(texts: list[str], usage: Usage) -> list[list[float]]:
    """Embed texts, reusing cached vectors. Only uncached texts count toward usage."""
    from app.agents.explain import count_tokens, truncate_tokens

    keys = [_key(t) for t in texts]
    with _cache_lock:
        missing = [i for i, k in enumerate(keys) if k not in _cache]
    if missing:
        from langchain_openai import OpenAIEmbeddings

        # The embedding model takes at most 8191 tokens per input.
        inputs = [truncate_tokens(texts[i], 8000) for i in missing]
        model = OpenAIEmbeddings(model=get_settings().embedding_model, api_key=require_key())
        # Small batches in parallel come back much faster than one big request,
        # which matters for the first question of a chat (nothing cached yet).
        batches = [inputs[i : i + _EMBED_BATCH] for i in range(0, len(inputs), _EMBED_BATCH)]
        with ThreadPoolExecutor(max_workers=min(8, len(batches))) as pool:
            vectors = [v for batch in pool.map(model.embed_documents, batches) for v in batch]
        usage.embedding_tokens += sum(count_tokens(t) for t in inputs)
        with _cache_lock:
            for i, vector in zip(missing, vectors):
                _cache[keys[i]] = vector
                _cache.move_to_end(keys[i])
            while len(_cache) > _CACHE_SIZE:
                _cache.popitem(last=False)
    with _cache_lock:
        return [_cache[k] for k in keys]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0
