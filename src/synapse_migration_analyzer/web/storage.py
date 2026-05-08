"""Filesystem-backed run repository.

Each run is a directory under ``runs_dir`` with this layout:

    runs/
      <id>/
        run.json              # RunMeta (status, modules, errors, ...)
        <module>.json         # analyzer module outputs (same as today's
                              # output_dir/<module>.json)
        events.ndjson         # append-only progress log (used by SSE
                              # replay)

The repo never executes analyzer code; it only persists results. See
``jobs.py`` for the actual run orchestration.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock

from .schemas import ModuleStatus, RunMeta

log = logging.getLogger(__name__)

_ID_RE = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}$")

# Hard cap on the number of progress events persisted per run. Beyond this we
# drop further entries (and emit a single ``lost_events`` sentinel) so a
# misbehaving analyzer cannot fill the disk via SSE.
_MAX_EVENTS_PER_RUN = 5000


class FilesystemRunRepo:
    """Thread-safe filesystem run repository.

    All filesystem joins go through ``run_dir`` which validates the id
    is well-formed and resolves under ``runs_dir`` (no path traversal).
    """

    def __init__(self, runs_dir: Path) -> None:
        self.runs_dir = runs_dir.resolve()
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        # Per-run event counter, used by ``append_event`` to enforce
        # ``_MAX_EVENTS_PER_RUN`` without re-reading the whole NDJSON file.
        self._event_counts: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Path helpers (path-traversal-safe)
    # ------------------------------------------------------------------

    def new_id(self) -> str:
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"{ts}-{secrets.token_hex(4)}"

    def _validate_id(self, run_id: str) -> str:
        if not _ID_RE.match(run_id):
            raise ValueError(f"invalid run id: {run_id!r}")
        return run_id

    def run_dir(self, run_id: str) -> Path:
        """Return the on-disk directory for ``run_id``.

        The id is validated against :data:`_ID_RE` and the resolved path is
        confirmed to live under ``runs_dir`` so caller-supplied values cannot
        traverse outside the repository.
        """
        run_id = self._validate_id(run_id)
        path = (self.runs_dir / run_id).resolve()
        # Defence-in-depth: even after the regex check, ensure the
        # resolved path is *under* runs_dir.
        if not path.is_relative_to(self.runs_dir):
            raise ValueError(f"path traversal blocked: {run_id!r}")
        return path

    # Back-compat alias for callers that still use the private name.
    _run_dir = run_dir

    def module_path(self, run_id: str, module: str) -> Path:
        # Module name must be one of the known schema keys; routers
        # validate that already, but defence-in-depth here too.
        if not re.fullmatch(r"[a-z][a-z0-9_]*", module):
            raise ValueError(f"invalid module name: {module!r}")
        path = (self.run_dir(run_id) / f"{module}.json").resolve()
        if not path.is_relative_to(self.runs_dir):
            raise ValueError("path traversal blocked")
        return path

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def create(self, meta: RunMeta) -> Path:
        with self._lock:
            run_dir = self.run_dir(meta.id)
            run_dir.mkdir(parents=True, exist_ok=False)
            self._write_meta(meta)
            return run_dir

    def list(self, *, limit: int = 50) -> list[RunMeta]:
        with self._lock:
            entries = sorted(
                (p for p in self.runs_dir.iterdir() if p.is_dir() and _ID_RE.match(p.name)),
                key=lambda p: p.name,
                reverse=True,
            )
            out: list[RunMeta] = []
            for p in entries[:limit]:
                meta = self._read_meta(p.name)
                if meta is not None:
                    out.append(meta)
            return out

    def get(self, run_id: str) -> RunMeta | None:
        with self._lock:
            return self._read_meta(run_id)

    def update(self, meta: RunMeta) -> None:
        with self._lock:
            self._write_meta(meta)

    def delete(self, run_id: str) -> bool:
        """Remove the on-disk directory for ``run_id``.

        Returns ``True`` if a directory was removed, ``False`` if the run
        did not exist. Path traversal is blocked by ``run_dir``.
        """
        import shutil

        with self._lock:
            run_dir = self.run_dir(run_id)
            if not run_dir.exists():
                return False
            shutil.rmtree(run_dir)
            self._event_counts.pop(run_id, None)
            return True

    def update_module(
        self,
        run_id: str,
        module: str,
        *,
        state: str,
        error: str | None = None,
        duration_ms: int | None = None,
    ) -> RunMeta:
        with self._lock:
            meta = self._read_meta(run_id)
            if meta is None:
                raise FileNotFoundError(run_id)
            now = datetime.now(timezone.utc)
            for ms in meta.modules:
                if ms.name == module:
                    ms.state = state  # type: ignore[assignment]
                    if state == "running" and ms.started_at is None:
                        ms.started_at = now
                    if state in ("ok", "failed", "skipped"):
                        ms.finished_at = now
                        if duration_ms is not None:
                            ms.duration_ms = duration_ms
                        elif ms.started_at is not None:
                            ms.duration_ms = int(
                                (now - ms.started_at).total_seconds() * 1000
                            )
                    if error is not None:
                        ms.error = error
                    break
            else:
                meta.modules.append(
                    ModuleStatus(name=module, state=state, started_at=now)
                )
            self._write_meta(meta)
            return meta

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _read_meta(self, run_id: str) -> RunMeta | None:
        path = self.run_dir(run_id) / "run.json"
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return RunMeta.model_validate(data)
        except (OSError, ValueError) as exc:
            log.warning("could not read run.json for %s: %s", run_id, exc)
            return None

    def _write_meta(self, meta: RunMeta) -> None:
        path = self.run_dir(meta.id) / "run.json"
        # Atomic write so a crash mid-write doesn't leave a half-file.
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(meta.model_dump_json(indent=2), encoding="utf-8")
        tmp.replace(path)

    # ------------------------------------------------------------------
    # SSE replay log
    # ------------------------------------------------------------------

    def append_event(self, run_id: str, event: dict) -> None:
        path = self.run_dir(run_id) / "events.ndjson"
        with self._lock:
            n = self._event_counts.get(run_id)
            if n is None:
                # First touch this process: count what's already on disk.
                if path.exists():
                    with path.open("r", encoding="utf-8") as fh:
                        n = sum(1 for line in fh if line.strip())
                else:
                    n = 0
            if n >= _MAX_EVENTS_PER_RUN:
                # Sentinel emitted at most once: subsequent appends are dropped
                # silently to avoid runaway disk use.
                if n == _MAX_EVENTS_PER_RUN:
                    sentinel = {
                        "type": "lost_events",
                        "reason": "event_cap_exceeded",
                        "limit": _MAX_EVENTS_PER_RUN,
                    }
                    with path.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps(sentinel) + "\n")
                    self._event_counts[run_id] = n + 1
                return
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(event) + "\n")
            self._event_counts[run_id] = n + 1

    def read_events(self, run_id: str) -> list[dict]:
        path = self.run_dir(run_id) / "events.ndjson"
        if not path.exists():
            return []
        with self._lock:
            return [
                json.loads(line)
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
