"""Tests for trigger → Fabric schedule mapping."""
from synapse_migration_analyzer.modules.pipelines import schedule_mapper


def test_schedule_trigger_weekly():
    trig = {
        "type": "ScheduleTrigger",
        "typeProperties": {
            "recurrence": {
                "frequency": "week", "interval": 1,
                "startTime": "2025-01-01T00:00:00Z",
                "schedule": {"weekDays": ["monday", "wednesday"]},
            }
        },
    }
    s = schedule_mapper.map_trigger(trig)
    assert s.kind == "recurring"
    assert s.every_n == 1
    assert s.interval == "Week"
    assert "Monday" in s.days_of_week and "Wednesday" in s.days_of_week


def test_tumbling_window_trigger():
    trig = {
        "type": "TumblingWindowTrigger",
        "typeProperties": {"frequency": "hour", "interval": 4},
    }
    s = schedule_mapper.map_trigger(trig)
    assert s.kind == "tumbling"
    assert s.every_n == 4


def test_event_trigger():
    s = schedule_mapper.map_trigger({"type": "BlobEventsTrigger"})
    assert s.kind == "event"


def test_render_human_returns_string():
    s = schedule_mapper.map_trigger({"type": "BlobEventsTrigger"})
    assert isinstance(schedule_mapper.render_human(s), str)
