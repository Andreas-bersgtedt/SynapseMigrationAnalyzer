# 09. Run page (start a new run)

## Purpose

Kick off a new analyzer run from the browser, watch its progress
live, and cancel it if needed. Control-plane only.

## How to open

- URL: `/run`.
- Modes: control plane only. The link is hidden in static mode.

## Inputs

The page does not consume any analyzer JSON — it talks to the API
(`/api/runs/start`, `/api/runs/{id}/cancel`, and the SSE stream
`/api/runs/{id}/events`).

## Layout

```
Start a new run

Label  [ pre-migration baseline ………………………………… ]

Modules
[x] dedicated_pools     [x] serverless_pools   [x] storage
[x] security            [x] governance         [x] monitoring
[x] cost                [ ] pipelines          [ ] fabric_validation
[x] fabric_mapping      [ ] policies

Options
[ ] --with-run-history     Days [ 7 ]
[ ] --with-data-flows
[ ] --with-pipeline-trends

[ Start run ]            [ Cancel ]   ← (visible while running)

──────────────────────────────────────────────────────────────────────
Progress
┌─────────────────────┬──────────┬────────────────────────────────────┐
│ Module              │ State    │ Latest event                       │
├─────────────────────┼──────────┼────────────────────────────────────┤
│ dedicated_pools     │ ● ok     │ collected 1 pool, 128 code objects │
│ serverless_pools    │ ● ok     │ no serverless pool found           │
│ storage             │ ◐ running│ enumerating containers (3/12)      │
│ fabric_mapping      │ ○ pending│ —                                  │
└─────────────────────┴──────────┴────────────────────────────────────┘
```

The progress table collapses each module to **one row** showing the
latest event. State pill: `pending` (muted), `running` (amber spinner),
`ok` (green), `failed` (red).

## Field reference

### Label

Free-text label persisted with the run. Shown in
[10. Runs history](10-runs-history.md) and in the run picker.
Optional, but strongly recommended (you'll thank yourself when the
list grows).

### Modules

The 11 first-class modules:

| Module             | Default | Notes |
| ------------------ | :-----: | ----- |
| `dedicated_pools`  |   ✓     | Inventory + code objects + T-SQL surface. |
| `serverless_pools` |   ✓     | Logical / external table inventory. |
| `storage`          |   ✓     | ADLS accounts, containers, capacities. |
| `security`         |   ✓     | Logins, roles, masking. |
| `governance`       |   ✓     | Naming, grants, ownership. |
| `monitoring`       |   ✓     | DWU usage / log query stats. |
| `cost`             |   ✓     | DWU-hours and spend attribution. |
| `pipelines`        |         | Pipelines + activities + linked services. |
| `fabric_validation` |        | Cross-checks against Fabric capacity targets. |
| `fabric_mapping`   |   ✓     | Aggregates everything into recommendations & runbook. |
| `policies`         |         | Subscription policy / role inventory. |

### Options

| Option                         | Effect |
| ------------------------------ | ------ |
| **--with-run-history**         | Pulls the last *N* days of pipeline run history. Required for the Pipeline activity section on the [Dashboard](04-dashboard.md). Slower (extra Monitor query). |
| **Days** (with run history)    | Window length — default 7. |
| **--with-data-flows**          | Includes Synapse Mapping Data Flow inventory (extra REST calls). |
| **--with-pipeline-trends**     | Computes per-pipeline trend stats over the run-history window. |

### Buttons

- **Start run** — submits the form to `/api/runs/start` and
  immediately writes the new run id to the URL hash and
  `sessionStorage`. The run picker switches to the new run on the
  next paint.
- **Cancel** — only visible while a run is in flight. Calls
  `/api/runs/{id}/cancel`. Modules that are mid-execution complete
  their current step before stopping.

## Common tasks

### "Run only pipelines for a quick check"

1. Uncheck every module except `pipelines` (and `fabric_mapping` if
   you want recommendations).
2. Tick **--with-run-history**.
3. Set **Days** to 1.
4. Click **Start run**.

A pipeline-only run typically finishes in under a minute.

### "Reproduce yesterday's run"

There is no "rerun with same options" button yet — copy the module /
option selection manually. The run-id of yesterday's run, plus the
[Diff page](11-diff-page.md), is the closest thing.

### "Run finished but the page didn't switch"

Click the run id in [10. Runs history](10-runs-history.md). The Run
page only updates the URL hash on **start**, not on completion — if
you navigated away and back, the page may still be tracking the same
run.

## Empty / error states

- "API not reachable" banner — the FastAPI server isn't running on
  the expected port. Start it with `sma serve --with-api`.
- A module shows **failed** — read the *Latest event* column for the
  short error and see [13. Troubleshooting](13-troubleshooting.md).
- `fabric_mapping` is selected but no upstream module is — it will
  produce an empty recommendations file. Always pair it with at least
  one collector.

## Related

- [02. Modes](02-modes.md) — why this page is hidden in static mode
- [10. Runs history](10-runs-history.md) — see the result
- [12. Configuration](12-configuration.md) — set the analyzer's target workspace
