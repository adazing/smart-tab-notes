"""Live check of /chat against 3 real pages, with time to first word.

    uv run uvicorn app.main:app --port 8000      # in one terminal
    uv run python scripts/chat_smoke.py          # in another

Uses samples/tabs.json (Backpropagation, Gradient descent and Python classes
from Wikipedia and docs.python.org, chunked by the extension's own chunker).
Needs a working OPENAI_API_KEY in backend/.env. Exits non-zero if any answer
fails or takes longer than 3 seconds to its first word.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
TABS = json.loads((Path(__file__).parent.parent / "samples" / "tabs.json").read_text())
TARGET_FIRST_TOKEN_S = 3.0

QUESTIONS = [
    ("one tab", "How does backpropagation use the chain rule?"),
    ("two tabs", "How do backpropagation and gradient descent work together to train a network?"),
    ("not covered", "What is the capital of France?"),
]


def ask(question: str) -> tuple[float | None, dict]:
    started = time.perf_counter()
    first: float | None = None
    done: dict = {}
    body = {"messages": [{"role": "user", "content": question}], "tabs": TABS}
    with httpx.stream("POST", f"{BASE}/chat", json=body, timeout=60) as response:
        if response.status_code != 200:
            raise SystemExit(f"HTTP {response.status_code}: {response.read().decode()}")
        event = None
        for line in response.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
                if event == "token":
                    if first is None:
                        first = time.perf_counter() - started
                    print(data["text"], end="", flush=True)
                elif event in ("done", "error"):
                    done = {"event": event, **data}
    print()
    return first, done


failures = 0
for label, question in QUESTIONS:
    print(f"\n=== {label}: {question}")
    first, done = ask(question)
    if done.get("event") != "done":
        print(f"FAILED: {done}")
        failures += 1
        continue
    slow = first is None or first > TARGET_FIRST_TOKEN_S
    failures += slow
    cites = ", ".join(f"[{c['n']}] tab {c['tab_id']} {c['chunk_id']} ({c['heading']})" for c in done["citations"])
    print(f"first word: {first:.2f}s{'  <-- over 3s' if slow else ''}" if first else "first word: none")
    print(f"covered={done['covered']} used_tab_ids={done['used_tab_ids']}")
    print(f"citations: {cites or 'none'}")
    print(f"tokens: {done['usage']}  timing: {done['timing']}")

sys.exit(1 if failures else 0)
