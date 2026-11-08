import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool

from app.agents.explain import explain_graph
from app.config import get_settings
from app.schemas import ExplainRequest, ExplainResponse

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="Smart Tab Notes API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://[a-z]+",
    allow_origins=get_settings().allowed_origin_list,
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
    except RuntimeError as exc:  # e.g. missing API key
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("/explain failed")
        raise HTTPException(status_code=502, detail="The explanation service failed. Try again.") from exc
    return ExplainResponse(explanation=result["explanation"], used_tab_ids=result["used_tab_ids"])
