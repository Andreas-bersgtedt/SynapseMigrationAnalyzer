import os

import pytest

from synapse_migration_analyzer.config import load_config


def test_load_config_missing_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    for k in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET",
              "AZURE_SUBSCRIPTION_ID", "SYNAPSE_RESOURCE_GROUP", "SYNAPSE_WORKSPACE_NAME"):
        monkeypatch.delenv(k, raising=False)
    # Use an empty .env file so dotenv doesn't load the repo's real one.
    empty = tmp_path / ".env"
    empty.write_text("")
    with pytest.raises(RuntimeError, match="Missing required environment variables"):
        load_config(empty)


def test_load_config_ok(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("AZURE_TENANT_ID", "t")
    monkeypatch.setenv("AZURE_CLIENT_ID", "c")
    monkeypatch.setenv("AZURE_CLIENT_SECRET", "s")
    monkeypatch.setenv("AZURE_SUBSCRIPTION_ID", "sub")
    monkeypatch.setenv("SYNAPSE_RESOURCE_GROUP", "rg")
    monkeypatch.setenv("SYNAPSE_WORKSPACE_NAME", "ws")
    monkeypatch.setenv("SMA_OUTPUT_DIR", str(tmp_path / "out"))
    cfg = load_config(tmp_path / ".env_does_not_exist")
    assert cfg.azure.workspace_name == "ws"
    assert cfg.output_dir.exists()
