import json
import logging
import time
import threading
from collections.abc import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import iterate_in_threadpool, run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app import llm
from app.agents.chat import chat_graph, rank_tabs
from app.agents.explain import explain_graph
from app.agents.recap import recap_graph
from app.llm import MissingAPIKeyError
from app.config import get_settings
from app.schemas import (
    ChatRequest,
    ExplainRequest,
    ExplainResponse,
    RankTabsRequest,
    RankTabsResponse,
    RecapRequest,
    RecapResponse,
)

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="Smart Tab Notes API", version="0.1.0")

_settings = get_settings()
if not _settings.extension_ids:
    logger.warning("EXTENSION_IDS is not set: any Chrome extension can call this API. Set it before deploying.")

app.add_middleware(
    CORSMiddleware,
    # Chrome extension ids are 32 letters a-p. Only used while EXTENSION_IDS is unset.
    allow_origin_regex=None if _settings.extension_ids else r"chrome-extension://[a-p]{32}",
    allow_origins=_settings.allowed_origin_list,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/explain", response_model=ExplainResponse)
async def explain(req: ExplainRequest) -> ExplainResponse:
    try:
        result = await run_in_threadpool(
            explain_graph.invoke,
            {
                "selected_text": req.selected_text,
                "page_text": req.page_text,
                "other_tabs": [t.model_dump() for t in req.other_tabs],
                "question": req.question,
            },
        )
    except MissingAPIKeyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("/explain failed")
        raise HTTPException(status_code=502, detail="The explanation service failed. Try again.") from exc
    return ExplainResponse(explanation=result["explanation"], used_tab_ids=result["used_tab_ids"])


@app.post("/recap", response_model=RecapResponse)
async def recap(req: RecapRequest) -> RecapResponse:
    """Remind a reader what they learned on a page: their notes and chats, recapped."""
    try:
        result = await run_in_threadpool(
            recap_graph.invoke,
            {
                "title": req.title,
                "url": req.url,
                "notes": [n.model_dump() for n in req.notes],
                "chat_summaries": req.chat_summaries,
            },
        )
    except MissingAPIKeyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("/recap failed")
        raise HTTPException(status_code=502, detail="The recap service failed. Try again.") from exc
    return RecapResponse(recap=result["recap"], points=result["points"])


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _require_key() -> None:
    try:
        llm.require_key()
    except MissingAPIKeyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/chat")
async def chat(req: ChatRequest, request: Request) -> StreamingResponse:
    """Stream an answer as Server-Sent Events: `token`* then `done` (or `error`)."""
    _require_key()

    async def events() -> AsyncIterator[str]:
        usage = llm.Usage()
        cancel = threading.Event()
        started = time.perf_counter()
        first_token_ms: int | None = None
        final: dict = {}
        outcome = "done"
        graph_events = chat_graph.stream(
            {
                "messages": [m.model_dump() for m in req.messages],
                "tabs": [t.model_dump() for t in req.tabs],
                "usage": usage,
                "cancel": cancel,
            },
            stream_mode=["custom", "values"],
        )
        try:
            # The graph is synchronous; run it in a worker thread so the event
            # loop stays free to notice the client disconnecting.
            async for mode, chunk in iterate_in_threadpool(graph_events):
                if await request.is_disconnected():
                    outcome = "disconnected"
                    return
                if mode == "custom" and "token" in chunk:
                    if first_token_ms is None:
                        first_token_ms = round((time.perf_counter() - started) * 1000)
                    yield _sse("token", {"text": chunk["token"]})
                elif mode == "values":
                    final = chunk
        except Exception:
            outcome = "error"
            logger.exception("/chat failed")
            yield _sse("error", {"detail": "The chat service failed. Try again."})
            return
        finally:
            # Stops answer_node after its current token if we left early
            # (disconnect, error, or Starlette cancelling this generator).
            cancel.set()
            usage.log(
                "/chat",
                outcome=outcome,
                tabs=len(req.tabs),
                sources=len(final.get("sources", [])),
                retrieval=final.get("retrieval"),
                first_token_ms=first_token_ms,
                total_ms=round((time.perf_counter() - started) * 1000),
            )

        total_ms = round((time.perf_counter() - started) * 1000)
        yield _sse(
            "done",
            {
                "answer": final.get("answer", ""),
                "citations": final.get("citations", []),
                "used_tab_ids": final.get("used_tab_ids", []),
                "covered": final.get("covered", False),
                "usage": usage.as_dict(),
                "timing": {"first_token_ms": first_token_ms, "total_ms": total_ms},
            },
        )

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/rank-tabs", response_model=RankTabsResponse)
async def rank_tabs_endpoint(req: RankTabsRequest) -> RankTabsResponse:
    _require_key()
    usage = llm.Usage()
    try:
        scores = await run_in_threadpool(
            rank_tabs, req.question, [t.model_dump() for t in req.tabs], usage
        )
    except Exception as exc:
        logger.exception("/rank-tabs failed")
        raise HTTPException(status_code=502, detail="Tab ranking failed. Try again.") from exc
    finally:
        usage.log("/rank-tabs", tabs=len(req.tabs))
    return RankTabsResponse(scores=scores)
