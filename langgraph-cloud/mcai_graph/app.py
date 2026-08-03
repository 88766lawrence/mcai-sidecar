from __future__ import annotations

import asyncio
import json
import os
import secrets
from functools import lru_cache
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse

from .graph import McaiGraph, ModelProvider, ModelProviderError, ProviderConfig


CONFIG_PATH = Path(os.environ.get("MCAI_MODEL_CONFIG", "/etc/mcai-model-cloud/config.json"))
STATE_PATH = Path(os.environ.get("MCAI_LANGGRAPH_STATE", "/var/lib/mcai-model-cloud/langgraph.sqlite3"))

app = FastAPI(title="MCAI LangGraph Model Cloud", docs_url=None, redoc_url=None)


def load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=4)
def graph_for(provider_key: str, base_url: str, model: str, planner_model: str, fallback_json: str) -> McaiGraph:
    fallback_models = tuple(json.loads(fallback_json))
    return McaiGraph(
        ModelProvider(ProviderConfig(provider_key, base_url, model, fallback_models)),
        STATE_PATH,
        ModelProvider(ProviderConfig(provider_key, base_url, planner_model, tuple(value for value in (model, *fallback_models) if value != planner_model))),
    )


def current_graph(config: dict[str, Any]) -> McaiGraph:
    provider = config.get("provider") or {}
    api_key = str(provider.get("apiKey") or "")
    base_url = str(provider.get("baseUrl") or "")
    model = str(provider.get("model") or "")
    fallback = tuple(value for value in provider.get("fallbackModels") or [] if isinstance(value, str) and value)
    planner_model = str(provider.get("plannerModel") or (fallback[0] if fallback else model))
    if not api_key or not base_url or not model:
        raise HTTPException(status_code=503, detail="MODEL_PROVIDER_UNCONFIGURED")
    return graph_for(api_key, base_url, model, planner_model, json.dumps(fallback))


def authorize(config: dict[str, Any], authorization: str | None) -> None:
    expected = str(config.get("serviceToken") or "")
    actual = (authorization or "").removeprefix("Bearer ").removeprefix("bearer ")
    if not expected or not secrets.compare_digest(actual, expected):
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")


@app.get("/health")
async def health() -> dict[str, Any]:
    config = load_config()
    provider = config.get("provider") or {}
    return {
        "status": "ok",
        "configured": bool(provider.get("apiKey") and provider.get("baseUrl") and provider.get("model")),
        "runtime": "python-langgraph",
    }


@app.get("/ready")
async def ready() -> dict[str, Any]:
    config = load_config()
    try:
        result = await current_graph(config).probe()
    except ModelProviderError as error:
        raise HTTPException(status_code=503, detail={"code": error.code}) from error
    return {"status": "ready", "runtime": "python-langgraph", "model": result["model"]}


@app.post("/v1/chat")
async def chat(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    config = load_config()
    authorize(config, authorization)
    if not isinstance(payload.get("message"), str) or not payload["message"].strip():
        raise HTTPException(status_code=400, detail="INVALID_MESSAGE")
    return await current_graph(config).route(payload)


@app.post("/v1/chat/stream")
async def chat_stream(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> StreamingResponse:
    config = load_config()
    authorize(config, authorization)
    if not isinstance(payload.get("message"), str) or not payload["message"].strip():
        raise HTTPException(status_code=400, detail="INVALID_MESSAGE")
    decision = await current_graph(config).route(payload)

    async def events() -> AsyncIterator[bytes]:
        answer = str(decision.get("answer", ""))
        yield _line({"type": "route", "route": str(decision.get("route", "direct"))})
        yield _line({"type": "reset"})
        for start in range(0, len(answer), 36):
            yield _line({"type": "delta", "text": answer[start:start + 36]})
            await asyncio.sleep(0)
        yield _line({"type": "done", "decision": decision})

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
    })


@app.post("/v1/respond")
async def respond(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    config = load_config()
    authorize(config, authorization)
    if not isinstance(payload.get("intent"), str) or not payload["intent"].strip():
        raise HTTPException(status_code=400, detail="INVALID_INTENT")
    return await current_graph(config).respond(payload)


def _line(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
