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

from .graph import McaiGraph, ModelProvider, ModelProviderError, ProviderCapabilityProfile, ProviderConfig


CONFIG_PATH = Path(os.environ.get("MCAI_MODEL_CONFIG", "/etc/mcai-model-cloud/config.json"))
STATE_PATH = Path(os.environ.get("MCAI_LANGGRAPH_STATE", "/var/lib/mcai-model-cloud/langgraph.sqlite3"))

app = FastAPI(title="MCAI LangGraph Model Cloud", docs_url=None, redoc_url=None)


def load_config() -> dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=4)
def graph_for(provider_key: str, base_url: str, model: str, planner_model: str, fallback_json: str, planner_mode: str) -> McaiGraph:
    fallback_models = tuple(json.loads(fallback_json))
    return McaiGraph(
        ModelProvider(ProviderConfig(provider_key, base_url, model, fallback_models)),
        STATE_PATH,
        ModelProvider(ProviderConfig(
            provider_key, base_url, planner_model,
            tuple(value for value in (model, *fallback_models) if value != planner_model),
            ProviderCapabilityProfile(mode=planner_mode if planner_mode in {"native_structured", "json_only"} else "json_only"),
        )),
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
    planner_mode = str(provider.get("plannerProviderMode") or "json_only")
    return graph_for(api_key, base_url, model, planner_model, json.dumps(fallback), planner_mode)


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


@app.post("/v1/agent-loop/decide")
async def decide_agent_loop(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    config = load_config()
    authorize(config, authorization)
    request_id = f"agent-loop-{secrets.token_hex(16)}"
    try:
        return await current_graph(config).decide_agent_loop({**payload, "_requestId": request_id})
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ModelProviderError as error:
        status = 504 if error.code == "TIMEOUT" else 422 if error.code == "AGENT_LOOP_INVALID_RESPONSE" else 503
        raise HTTPException(status_code=status, detail={
            "code": error.code,
            "requestId": request_id,
            "repairUsed": bool(error.metrics.get("repair_used")),
        }) from error


@app.post("/v1/intent/compile")
async def compile_intent(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    config = load_config()
    authorize(config, authorization)
    catalog = payload.get("sourceCatalog")
    if not isinstance(catalog, dict) or catalog.get("schema_version") != "intent-source-catalog/v1" or not isinstance(catalog.get("refs"), list):
        raise HTTPException(status_code=400, detail="INVALID_SOURCE_CATALOG")
    if payload.get("attempt") not in (1, 2):
        raise HTTPException(status_code=400, detail="INVALID_ATTEMPT")
    request_id = f"intent-{secrets.token_hex(16)}"
    try:
        return await current_graph(config).compile_intent({**payload, "_requestId": request_id})
    except ModelProviderError as error:
        error.metrics.setdefault("request_id", request_id)
        if error.code == "INTENT_COMPILER_PROVIDER_TIMEOUT":
            status = 504
        elif error.code in {"INTENT_COMPILER_PARSE_ERROR", "INTENT_COMPILER_VALIDATION_ERROR", "INTENT_COMPILER_BUDGET_EXCEEDED", "INTENT_COMPILER_INPUT_BUDGET_EXCEEDED", "INTENT_COMPILER_OUTPUT_BUDGET_EXCEEDED"}:
            status = 422
        else:
            status = 503
        metrics = _compiler_metrics(error.metrics)
        raise HTTPException(status_code=status, detail={
            "code": error.code,
            "requestId": request_id,
            "provider": str(metrics.get("provider") or ""),
            "httpStatus": status,
            "compilerMetrics": metrics,
            "repairUsed": bool(metrics.get("repair_used")),
        }) from error


@app.post("/v1/confirmed-write/propose")
async def propose_confirmed_write(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    config = load_config()
    authorize(config, authorization)
    if not isinstance(payload.get("intent"), str) or not payload["intent"].strip():
        raise HTTPException(status_code=400, detail="INVALID_INTENT")
    if payload.get("allowedTools") != ["console.command"]:
        raise HTTPException(status_code=400, detail="INVALID_ALLOWED_TOOLS")
    request_id = f"write-proposal-{secrets.token_hex(16)}"
    try:
        return await current_graph(config).propose_confirmed_write({**payload, "_requestId": request_id})
    except ModelProviderError as error:
        error.metrics.setdefault("request_id", request_id)
        status = 504 if error.code == "WRITE_PROPOSAL_PROVIDER_TIMEOUT" else 422 if error.code == "WRITE_PROPOSAL_PARSE_ERROR" else 503
        metrics = _compiler_metrics(error.metrics)
        raise HTTPException(status_code=status, detail={
            "code": error.code, "requestId": request_id, "provider": str(metrics.get("provider") or ""),
            "httpStatus": status, "proposalMetrics": metrics, "repairUsed": bool(metrics.get("repair_used")),
        }) from error


def _compiler_metrics(value: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "provider", "mode", "attempt", "provider_ms", "parse_ms", "validate_ms", "total_ms",
        "input_chars", "prompt_chars", "schema_chars", "output_chars", "input_token_estimate",
        "prompt_token_estimate", "schema_token_estimate", "output_token_estimate", "attempt_budget_ms",
        "total_budget_ms", "max_output_tokens", "shard_id", "provider_call_index", "frame_count",
        "shard_count", "provider_call_count", "completed_shard_count", "cancelled_shard_count",
        "max_concurrency", "max_provider_calls", "deadline_ms", "repair_reason", "repair_used",
        "terminal_code", "cancelled", "request_id",
    }
    return {key: item for key, item in value.items() if key in allowed and isinstance(item, (str, int, float, bool))}


def _line(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
