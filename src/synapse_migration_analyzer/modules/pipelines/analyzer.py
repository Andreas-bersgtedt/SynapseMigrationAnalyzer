"""Orchestrator for the pipelines module."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from ...config import AppConfig
from ...errors import format_error
from . import expression_compat, schedule_mapper
from .artifacts_client import ArtifactsApiClient
from .models import ExpressionFinding, PipelinesAnalysis, ScheduleMapping

log = logging.getLogger(__name__)


class PipelinesAnalyzer:
    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._api = ArtifactsApiClient(cfg.azure)

    def run(self) -> PipelinesAnalysis:
        result = PipelinesAnalysis(
            workspace_name=self._cfg.azure.workspace_name,
            subscription_id=self._cfg.azure.subscription_id,
            resource_group=self._cfg.azure.resource_group,
            artifacts_endpoint=self._api.endpoint,
            generated_at=datetime.now(timezone.utc),
        )

        # Pipelines + activities (walked together so we only call the API once).
        try:
            pipes: list = []
            acts: list = []
            for pipe, activities in self._api.iter_pipelines_with_activities():
                pipes.append(pipe)
                acts.extend(activities)
            result.pipelines = pipes
            result.activities = acts
        except Exception as exc:  # noqa: BLE001
            log.warning("pipelines collection failed: %s", exc)
            result.errors.append(format_error("pipelines", exc))

        for label, fn, attr in (
            ("linked_services", self._api.list_linked_services, "linked_services"),
            ("datasets", self._api.list_datasets, "datasets"),
            ("triggers", self._api.list_triggers, "triggers"),
            ("integration_runtimes", self._api.list_integration_runtimes, "integration_runtimes"),
        ):
            try:
                setattr(result, attr, list(fn()))
            except Exception as exc:  # noqa: BLE001
                log.warning("%s collection failed: %s", label, exc)
                result.errors.append(format_error(label, exc))

        # v2 — expression-language compatibility scan over activity payloads.
        try:
            findings = expression_compat.scan_activities(
                [a.model_dump() for a in result.activities]
            )
            result.expression_findings = [
                ExpressionFinding(
                    rule_id=f.rule_id, label=f.label, severity=f.severity,
                    pipeline=f.pipeline, activity=f.activity, expression=f.expression,
                )
                for f in findings
            ]
        except Exception as exc:  # noqa: BLE001
            log.warning("expression_compat failed: %s", exc)
            result.errors.append(f"expression_compat: {exc}")

        # v2 — trigger schedule → Fabric schedule mapping.
        try:
            for trig in result.triggers:
                sched = schedule_mapper.map_trigger(trig.model_dump())
                result.schedule_mappings.append(ScheduleMapping(
                    trigger_name=trig.name,
                    trigger_type=trig.type,
                    fabric_kind=sched.kind,
                    every_n=sched.every_n,
                    interval=sched.interval,
                    days_of_week=list(sched.days_of_week),
                    start_time_utc=sched.start_time_utc,
                    end_time_utc=sched.end_time_utc,
                    notes=list(sched.notes),
                    summary=schedule_mapper.render_human(sched),
                ))
        except Exception as exc:  # noqa: BLE001
            log.warning("schedule_mapper failed: %s", exc)
            result.errors.append(f"schedule_mapper: {exc}")

        return result
