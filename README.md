# Codex Monitor

See how much Codex quota remains, when it resets, and which tasks use the most.
A local dashboard with live activity, compact task rows, and expandable details.

![Codex Monitor dashboard showing weekly quota and per-task metrics, with task titles blurred for privacy](assets/codex-monitor-dashboard-redacted.png)

## Quick start

Use Node.js 22 or newer and an authenticated Codex installation that supports
`codex app-server`. Run from the repository root:

```bash
npm ci
npm run build
npm start
```

Open [Codex Monitor](http://127.0.0.1:4201). Keep the terminal running; use
`Ctrl+C` to stop the monitor. On macOS, a signed-in Codex or ChatGPT desktop app
with the bundled Codex executable is sufficient.

For background launch, desktop shortcuts, and Windows options, see the
[launcher guide](docs/setup-and-reference.md#on-demand-launchers).

## At a glance

- **Quota and pace:** remaining overall Codex quota, one reset countdown, and
  consumption compared with elapsed time. Spark is excluded.
- **Task usage:** estimated total cost, total tokens, and approximate quota share
  stay visible in every row. Figures refresh automatically while you work.
- **Find your work:** search, filter by Active / Today / All, and sort by usage or
  last activity.
- **Expand a task:** click its row or use Tab and Enter/Space on its title.
  Details include the preview, path, token breakdown, and a separate
  **Open in Codex** link. Tracked runs also provide live transcripts.
- **Optional auto shutdown:** controls stay in the footer. Real shutdown is
  Windows-only; macOS/Linux use dry-run mode by default.

## Reading the numbers

| Metric | Period |
| --- | --- |
| Estimated total cost | Entire task · API-equivalent USD, not a plan charge |
| Total tokens | Entire task, including attributable subagents |
| Approx. usage % | Since the primary quota reset |

Each observed quota increase is divided in proportion to the API-equivalent
cost recorded by each task since the previous increase, then accumulated since
reset. Earlier allocations do not shrink when another task works. Consumption
before the first observation and increments without sufficient priced usage
remain unattributed, shown above the table. Attribution persists across monitor
restarts in `.cache/quota-attribution.json`; observation runs with quota polling
even when the dashboard is closed.
A `+` marks a partial cost estimate; `--` means unavailable. The header reports
Codex's overall quota, while task shares are estimates. See
[metric details](docs/setup-and-reference.md#metric-details) for the calculation
and refresh periods.

Activity follows session events and expires after 15 minutes without an update.
Internal subagents are excluded from the task list; their attributable usage is
included in the parent task. Titles also use the local desktop title index, then
fall back to user requests with injected setup
removed. Missing token records or unknown model prices remain unavailable.

## More information

The monitor binds to loopback and reads your local Codex history. Task details
can contain private text; keep it local. Only task titles are blurred in the
screenshot above.

- [Setup, configuration, and troubleshooting](docs/setup-and-reference.md)
- [Shutdown behavior](docs/setup-and-reference.md#shutdown-automation)
- [Development and checks](docs/setup-and-reference.md#run-in-development)
- [Platform verification](docs/setup-and-reference.md#platform-verification)
