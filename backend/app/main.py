import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool

from app.agents.explain import MissingAPIKeyError, explain_graph
from app.config import get_settings
from app.schemas import ExplainRequest, ExplainResponse

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
            },
        )
    except MissingAPIKeyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("/explain failed")
        raise HTTPException(status_code=502, detail="The explanation service failed. Try again.") from exc
    return ExplainResponse(explanation=result["explanation"], used_tab_ids=result["used_tab_ids"])
