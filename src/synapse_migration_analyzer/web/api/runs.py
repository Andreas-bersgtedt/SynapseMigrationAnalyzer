"""PR-2 stub: run lifecycle endpoints (POST/list/get/delete).

Implemented in PR-2; see the package PLAN_CONTROL_PLANE.md.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import AppState, get_state
from ..schemas import RunMeta, StartRunRequest, StartRunResponse

router = APIRouter()


@router.post("", response_model=StartRunResponse, status_code=status.HTTP_202_ACCEPTED)
async def start_run(
    body: StartRunRequest,
    state: AppState = Depends(get_state),
) -> StartRunResponse:
    try:
        meta = await state.runner.start(body.modules, label=body.label)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return StartRunResponse(id=meta.id, status=meta.status)


@router.get("", response_model=list[RunMeta])
def list_runs(
    limit: int = 50,
    state: AppState = Depends(get_state),
) -> list[RunMeta]:
    return state.repo.list(limit=limit)


@router.get("/{run_id}", response_model=RunMeta)
def get_run(run_id: str, state: AppState = Depends(get_state)) -> RunMeta:
    try:
        meta = state.repo.get(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if meta is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    return meta


@router.delete("/{run_id}", status_code=status.HTTP_202_ACCEPTED)
def cancel_run(run_id: str, state: AppState = Depends(get_state)) -> dict[str, bool]:
    try:
        state.repo.get(run_id)  # validates id
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cancelled = state.runner.cancel(run_id)
    return {"cancelled": cancelled}
