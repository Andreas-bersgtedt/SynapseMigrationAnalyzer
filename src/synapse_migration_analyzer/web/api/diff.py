"""Compute a delta between two runs by reusing the existing run_manifest
helpers. Returns the JSON envelope exactly as ``run_delta.json`` does
when produced by ``analyze-all``.
"""
from __future__ import annotations

import dataclasses
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ...reporting.run_manifest import (
    ManifestDiffEntry,
    build_manifest,
    diff_manifests,
    diff_summary,
)
from ..deps import AppState, get_state


def _entry_to_dict(entry: ManifestDiffEntry) -> dict[str, Any]:
    """Serialise a ``ManifestDiffEntry`` (frozen dataclass) to a JSON-ready dict."""
    out = dataclasses.asdict(entry)
    for k, v in list(out.items()):
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    out["size_delta"] = entry.size_delta
    out["record_count_delta"] = entry.record_count_delta
    return out

router = APIRouter()


@router.get("/{run_id}/diff")
def get_diff(
    run_id: str,
    base: str | None = None,
    state: AppState = Depends(get_state),
) -> dict:
    """Return a delta from ``base`` (defaults to the previous run) to ``run_id``.

    The base+head are looked up by id and their on-disk JSON is fed to
    ``build_manifest`` + ``diff_manifests``. If only one run exists,
    returns an empty delta.
    """
    try:
        head_meta = state.repo.get(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if head_meta is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")

    if base is None:
        # Pick the most recent finished run *before* this one.
        all_runs = state.repo.list(limit=200)
        prev = next(
            (r for r in all_runs if r.id < run_id and r.status in ("ok", "failed")),
            None,
        )
        base_id = prev.id if prev else None
    else:
        try:
            base_meta = state.repo.get(base)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if base_meta is None:
            raise HTTPException(status_code=404, detail=f"run {base} not found")
        base_id = base

    head_dir = state.repo.run_dir(run_id)
    head_manifest = build_manifest(
        head_dir,
        # ``RunManifest`` requires non-None strings for these fields. The
        # web control plane doesn't persist the original Azure context per
        # run, so emit empty strings here — the diff endpoint only consumes
        # the artifact list, not the workspace metadata.
        workspace_name="",
        subscription_id="",
        resource_group="",
        sma_version="api",
        file_names=[p.name for p in head_dir.glob("*.json") if p.name not in ("run.json", "run_manifest.json")],
    )

    base_manifest = None
    if base_id:
        base_dir = state.repo.run_dir(base_id)
        base_manifest = build_manifest(
            base_dir,
            workspace_name="",
            subscription_id="",
            resource_group="",
            sma_version="api",
            file_names=[p.name for p in base_dir.glob("*.json") if p.name not in ("run.json", "run_manifest.json")],
        )

    diff = diff_manifests(base_manifest, head_manifest)
    return {
        "base": base_id,
        "head": run_id,
        "summary": diff_summary(diff),
        "delta": [_entry_to_dict(entry) for entry in diff],
    }
