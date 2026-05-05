"""In-process analyzer run orchestrator for the local web control plane.

The runner re-uses the same Analyzer + write_reports functions the CLI
uses; nothing about the analysis logic moves into ``web/``. Each run is
serialised by an ``asyncio.Lock`` (analyzer is IO-heavy and external
APIs are rate-limited) and runs in a worker thread so it doesn't block
the event loop.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import threading
import time
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import AppConfig, load_config
from ..modules import MODULE_REGISTRY
from .schemas import KNOWN_MODULES, ModuleStatus, RunMeta
from .storage import FilesystemRunRepo

log = logging.getLogger(__name__)


def _module_dispatch() -> dict[str, Callable[[AppConfig], tuple[Any, Callable[..., list[Path]]]]]:
    """Return the analyzer dispatch table.

    Thin wrapper around :data:`..modules.MODULE_REGISTRY` so callers (and
    tests) can pass a custom ``dispatch=`` to ``JobRunner.__init__`` while
    the production default stays in lockstep with the CLI.
    """
    return dict(MODULE_REGISTRY)


def hash_config(cfg: AppConfig) -> str:
    """sha256 of the redacted AppConfig (secret excluded)."""
    payload = {
        "tenant_id": cfg.azure.tenant_id,
        "client_id": cfg.azure.client_id,
        "subscription_id": cfg.azure.subscription_id,
        "resource_group": cfg.azure.resource_group,
        "workspace_name": cfg.azure.workspace_name,
        "dedicated_pool": cfg.azure.dedicated_pool,
        "odbc_driver": cfg.sql.odbc_driver,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode("utf-8")
    ).hexdigest()


class JobRunner:
    """Single-runner queue. Only one analyzer run executes at a time."""

    def __init__(
        self,
        repo: FilesystemRunRepo,
        *,
        env_file: Path | None = None,
        dispatch: dict[str, Callable[[AppConfig], tuple[Any, Callable[..., list[Path]]]]] | None = None,
        load_cfg: Callable[[Path | None], AppConfig] | None = None,
    ) -> None:
        self.repo = repo
        self.env_file = env_file
        self._dispatch = dispatch or _module_dispatch()
        self._load_cfg = load_cfg or load_config
        self._lock = asyncio.Lock()
        # ``_busy`` is the authoritative "a run is in flight" flag. It is
        # mutated only from the asyncio thread and is set *before* the
        # background task is scheduled to close the TOCTOU race that
        # checking ``self._lock.locked()`` had: ``_lock`` is acquired
        # inside ``_run`` which is scheduled via ``create_task`` and
        # therefore not yet acquired when ``start`` returns.
        self._busy = False
        self._cancel: dict[str, threading.Event] = {}
        self._subscribers: dict[str, list[asyncio.Queue[dict]]] = {}
        self._sub_lock = threading.Lock()
        # Per-run flag tracking whether we have already emitted a
        # ``lost_events`` sentinel for the live SSE channel after the
        # subscriber queue overflowed; the persisted log has its own
        # cap enforced by :class:`FilesystemRunRepo`.
        self._lost_emitted: set[str] = set()

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def known_modules(self) -> tuple[str, ...]:
        return KNOWN_MODULES

    # ------------------------------------------------------------------
    # Subscribe / publish (used by the SSE endpoint)
    # ------------------------------------------------------------------

    def subscribe(self, run_id: str) -> asyncio.Queue[dict]:
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=512)
        with self._sub_lock:
            self._subscribers.setdefault(run_id, []).append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue[dict]) -> None:
        with self._sub_lock:
            subs = self._subscribers.get(run_id, [])
            if q in subs:
                subs.remove(q)
            if not subs and run_id in self._subscribers:
                del self._subscribers[run_id]

    def _publish(self, run_id: str, event: dict) -> None:
        # Persist for replay-on-reconnect.
        try:
            self.repo.append_event(run_id, event)
        except Exception:  # noqa: BLE001
            log.exception("failed to persist event for %s", run_id)
        # Fan out to live subscribers; if any queue is full, emit a single
        # ``lost_events`` marker so the SPA can surface a banner instead of
        # silently missing progress updates.
        with self._sub_lock:
            subs = list(self._subscribers.get(run_id, ()))
        any_dropped = False
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                any_dropped = True
        if any_dropped and run_id not in self._lost_emitted:
            self._lost_emitted.add(run_id)
            sentinel = {
                "type": "lost_events",
                "reason": "subscriber_queue_full",
                "run_id": run_id,
            }
            with self._sub_lock:
                subs2 = list(self._subscribers.get(run_id, ()))
            for q in subs2:
                try:
                    q.put_nowait(sentinel)
                except asyncio.QueueFull:
                    log.warning("SSE queue full; dropping lost_events sentinel for %s", run_id)

    # ------------------------------------------------------------------
    # Run lifecycle
    # ------------------------------------------------------------------

    def cancel(self, run_id: str) -> bool:
        ev = self._cancel.get(run_id)
        if ev is None:
            return False
        ev.set()
        return True

    async def start(self, modules: list[str], *, label: str | None = None) -> RunMeta:
        unknown = [m for m in modules if m not in self._dispatch]
        if unknown:
            raise ValueError(f"unknown modules: {unknown}. Known: {sorted(self._dispatch)}")

        # Atomically claim the runner: asyncio is single-threaded so the
        # check + assignment cannot interleave with another coroutine until
        # the next ``await``.
        if self._busy:
            raise RuntimeError("a run is already in flight")
        self._busy = True
        try:
            # Sort selected modules into canonical execution order so
            # `fabric_mapping` (which reads upstream JSON) always runs after
            # its inputs, regardless of the order the SPA submitted them.
            canonical = list(KNOWN_MODULES)
            modules = sorted(set(modules), key=canonical.index)

            # Build initial RunMeta and persist it before we kick off the work
            # so the API can return the id immediately.
            cfg = self._load_cfg(self.env_file)
            meta = RunMeta(
                id=self.repo.new_id(),
                label=label,
                status="queued",
                started_at=datetime.now(timezone.utc),
                config_hash=hash_config(cfg),
                modules=[ModuleStatus(name=m, state="queued") for m in modules],
            )
            self.repo.create(meta)
            self._cancel[meta.id] = threading.Event()

            # Spawn the actual work. ``_busy`` will be cleared by ``_run``.
            loop = asyncio.get_running_loop()
            loop.create_task(self._run(meta, cfg))
            return meta
        except BaseException:
            # Failed to schedule — release the slot so subsequent attempts work.
            self._busy = False
            raise

    async def _run(self, meta: RunMeta, cfg: AppConfig) -> None:
        run_id = meta.id
        try:
            async with self._lock:
                meta.status = "running"
                self.repo.update(meta)
                self._publish(run_id, {"type": "run_started", "run_id": run_id})

                cancel = self._cancel[run_id]
                run_dir = self.repo.run_dir(run_id)
                # The fabric_mapping analyzer reads its inputs from
                # cfg.output_dir, so point the config at run_dir for the
                # duration of this run. ``AppConfig`` is a frozen dataclass
                # in production; tests may pass a non-dataclass mock, so
                # fall back to attribute assignment in that case.
                import dataclasses as _dc
                if _dc.is_dataclass(cfg) and not isinstance(cfg, type):
                    cfg = _dc.replace(cfg, output_dir=run_dir)
                else:
                    try:
                        cfg.output_dir = run_dir  # type: ignore[attr-defined]
                    except Exception:  # noqa: BLE001
                        log.warning("could not override output_dir on cfg %r", type(cfg))
                partial_failure = False

            for ms in list(meta.modules):
                if cancel.is_set():
                    self.repo.update_module(run_id, ms.name, state="cancelled")
                    self._publish(run_id, {
                        "type": "module_finished", "module": ms.name, "state": "cancelled",
                    })
                    continue

                self.repo.update_module(run_id, ms.name, state="running")
                self._publish(run_id, {"type": "module_started", "module": ms.name})
                t0 = time.monotonic()
                try:
                    factory = self._dispatch[ms.name]
                    # Run analyzer + write_reports in a thread pool so we
                    # don't block the event loop. write_reports persists
                    # JSON / CSV / Markdown / HTML next to run_dir.
                    await asyncio.to_thread(
                        _run_module_sync, factory, cfg, run_dir,
                    )
                    duration_ms = int((time.monotonic() - t0) * 1000)
                    self.repo.update_module(
                        run_id, ms.name, state="ok", duration_ms=duration_ms,
                    )
                    self._publish(run_id, {
                        "type": "module_finished",
                        "module": ms.name,
                        "state": "ok",
                        "duration_ms": duration_ms,
                    })
                except Exception as exc:  # noqa: BLE001
                    log.exception("module %s failed in run %s", ms.name, run_id)
                    duration_ms = int((time.monotonic() - t0) * 1000)
                    self.repo.update_module(
                        run_id, ms.name, state="failed",
                        error=str(exc), duration_ms=duration_ms,
                    )
                    self._publish(run_id, {
                        "type": "module_finished",
                        "module": ms.name,
                        "state": "failed",
                        "error": str(exc),
                        "duration_ms": duration_ms,
                    })
                    partial_failure = True

            # Final RunMeta state.
            final = self.repo.get(run_id) or meta
            final.finished_at = datetime.now(timezone.utc)
            final.errors_count = sum(1 for m in final.modules if m.state == "failed")
            if cancel.is_set():
                final.status = "cancelled"
            elif partial_failure:
                final.status = "failed"
            else:
                final.status = "ok"
            # Reflect readiness from fabric_mapping if present.
            fm = run_dir / "fabric_mapping.json"
            if fm.exists():
                try:
                    data = json.loads(fm.read_text(encoding="utf-8"))
                    score = data.get("readiness", {}).get("score")
                    if isinstance(score, (int, float)):
                        final.readiness_score = float(score)
                except Exception:  # noqa: BLE001
                    pass
            self.repo.update(final)
            self._publish(run_id, {
                "type": "done",
                "status": final.status,
                "errors_count": final.errors_count,
                "readiness_score": final.readiness_score,
            })
            # Clean up the cancel event.
            self._cancel.pop(run_id, None)
        finally:
            # Release the runner slot whether the run finished cleanly or
            # raised. ``start`` will refuse new runs until this clears.
            self._busy = False
            self._lost_emitted.discard(run_id)


def _run_module_sync(
    factory: Callable[[AppConfig], tuple[Any, Callable[..., list[Path]]]],
    cfg: AppConfig,
    run_dir: Path,
) -> AsyncIterator[None]:
    """Helper: invoke the module's analyzer + writer with the run dir.

    Run synchronously; called via ``asyncio.to_thread``.
    """
    result, writer = factory(cfg)
    # Every analyzer's writer accepts (result, output_dir, formats=...).
    writer(result, run_dir, formats=["json", "csv", "markdown", "html"])
    return None  # type: ignore[return-value]
