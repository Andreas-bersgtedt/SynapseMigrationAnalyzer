"""Module results for a given run.

Returns the analyzer's per-module JSON file (e.g. ``dedicated_pools.json``).
The file path is built via ``FilesystemRunRepo.module_path`` which
validates the module name and resolves under ``runs_dir`` so a malicious
``../`` cannot escape.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from ..deps import AppState, get_state
from ..schemas import KNOWN_MODULES

router = APIRouter()


@router.get("/{run_id}/modules/{module}")
def get_module(
    run_id: str,
    module: str,
    state: AppState = Depends(get_state),
) -> JSONResponse:
    if module not in KNOWN_MODULES:
        raise HTTPException(status_code=404, detail=f"unknown module {module!r}")
    try:
        path = state.repo.module_path(run_id, module)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{module}.json not produced for run {run_id}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"could not read {module}.json: {exc}") from exc
    return JSONResponse(content=data)
