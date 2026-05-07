"""Configuration endpoints (.env read/write/validate).

Reads always redact ``AZURE_CLIENT_SECRET`` to ``"set"``/``"unset"``.
Writes accept a plaintext secret only via ``PUT /api/config`` and only
when the X-SMA-API marker is present (enforced globally).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config_io import read_config, validate_config, validate_config_live, write_config
from ..deps import AppState, get_state
from ..schemas import (
    AppConfigPublic,
    AppConfigUpdate,
    SaveConfigResponse,
    ValidateConfigResponse,
)

router = APIRouter()


@router.get("", response_model=AppConfigPublic)
def get_config(state: AppState = Depends(get_state)) -> AppConfigPublic:
    return read_config(state.env_file)


@router.put("", response_model=SaveConfigResponse)
def put_config(
    body: AppConfigUpdate,
    state: AppState = Depends(get_state),
) -> SaveConfigResponse:
    warnings = write_config(state.env_file, body)
    return SaveConfigResponse(saved_to=state.env_file, warnings=warnings)


@router.post("/validate", response_model=ValidateConfigResponse)
def validate(
    live: bool = False,
    state: AppState = Depends(get_state),
) -> ValidateConfigResponse:
    """Validate the saved .env config.

    ``?live=true`` additionally exercises Azure control-plane (ARM) and
    Synapse data-plane (Artifacts REST + SQL ``SELECT 1``) connectivity using
    the configured service principal, so the user can confirm RBAC was granted
    on both planes.
    """
    checks = validate_config_live(state.env_file) if live else validate_config(state.env_file)
    return ValidateConfigResponse(ok=all(c.ok for c in checks), checks=checks)
