"""Rollup helpers turning per-step estimates into a project-level summary."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable

from ..modules.fabric_mapping.models import RunbookStep
from .estimator import EffortEstimate


@dataclass(frozen=True)
class PhaseEffortRollup:
    phase: str
    p50_hours: float
    p90_hours: float
    step_count: int


@dataclass(frozen=True)
class EffortRollup:
    total_p50_hours: float
    total_p90_hours: float
    per_phase: list[PhaseEffortRollup] = field(default_factory=list)
    card_source: str = "default"
    card_version: int = 1

    def to_dict(self) -> dict:
        return {
            "total_p50_hours": round(self.total_p50_hours, 2),
            "total_p90_hours": round(self.total_p90_hours, 2),
            "per_phase": [
                {
                    "phase": p.phase,
                    "p50_hours": round(p.p50_hours, 2),
                    "p90_hours": round(p.p90_hours, 2),
                    "step_count": p.step_count,
                }
                for p in self.per_phase
            ],
            "card_source": self.card_source,
            "card_version": self.card_version,
        }


def build_rollup(
    steps: Iterable[RunbookStep],
    estimates: Iterable[EffortEstimate],
    *,
    card_source: str,
    card_version: int,
) -> EffortRollup:
    """Sum estimates by phase and overall, preserving phase order."""
    estimates_by_order = {e.step_order: e for e in estimates}
    phase_p50: dict[str, float] = defaultdict(float)
    phase_p90: dict[str, float] = defaultdict(float)
    phase_count: dict[str, int] = defaultdict(int)
    phase_order: list[str] = []

    for step in steps:
        if step.phase not in phase_count:
            phase_order.append(step.phase)
        est = estimates_by_order.get(step.order)
        if est is None:
            continue
        phase_p50[step.phase] += est.p50_hours
        phase_p90[step.phase] += est.p90_hours
        phase_count[step.phase] += 1

    per_phase = [
        PhaseEffortRollup(
            phase=p,
            p50_hours=round(phase_p50[p], 2),
            p90_hours=round(phase_p90[p], 2),
            step_count=phase_count[p],
        )
        for p in phase_order
    ]
    total_p50 = round(sum(phase_p50.values()), 2)
    total_p90 = round(sum(phase_p90.values()), 2)
    return EffortRollup(
        total_p50_hours=total_p50,
        total_p90_hours=total_p90,
        per_phase=per_phase,
        card_source=card_source,
        card_version=card_version,
    )
