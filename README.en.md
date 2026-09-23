# Codex Monitor

**Understand where your Codex usage goes — by task, project, and time range.**

[简体中文](README.md) | English

**Latest: [v0.4.1](https://github.com/tabztggg/codex-monitor/releases/tag/v0.4.1)** ·
Parallel-chat calibration and duplicate-log fixes, with sticky header navigation · [Changelog and upgrade notes](CHANGELOG.md)

A local dashboard for account quota, recorded tokens, estimated costs, and live
activity. This customized version builds on
[manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor) with bilingual
controls, archived-task statistics, project summaries, and usage analysis.
It is an unofficial community project, not an OpenAI product or billing system.

## Screenshots

These v0.4.0 screenshots use the actual application with fictional accounts,
projects, tasks, and usage. No private data is shown. The full table includes all
seven columns; optional project grouping is off by default.

### Dashboard at a glance

Separate current-account quota, cross-account estimates, and task details, with
explicit period start, end/reset, and data-cutoff labels.

![Codex Monitor v0.4.0 English dashboard with account quota, cross-account estimates, period boundaries and task details](assets/screenshots/overview-en.jpg)

### Project totals

Turn on project grouping to compare quota, 20x equivalents, cost, and tokens.
Expand a project to see its tasks; collapsed projects keep their totals visible.

![Project groups with aggregate quota percentages, estimated costs and total tokens](assets/screenshots/projects-en.jpg)

### Daily trends and project ranking

Open the analysis panel to explore daily usage and compare the busiest projects.
Switch the metric between estimated cost, tokens, and 20x equivalents.

![Daily cost trend and project usage ranking in Codex Monitor](assets/screenshots/trends-en.jpg)

## Features

| Feature | What you can do |
| --- | --- |
| Account overview | Account identity, remaining quota, reset countdown, and pace. Failed reads retain a labeled last-confirmed snapshot. Spark is excluded. |
| Task statistics | Compare recorded tokens, API-equivalent USD estimates, and approximate current-account quota attribution. |
| Plan equivalents | Compare locally recorded usage across accounts with one Pro 20x, Pro 5x, or Plus weekly allowance. Totals can exceed 100%; valid calibration survives resets and restarts. |
| Project summaries | Optionally group tasks by saved Codex project and see quota, 20x, cost, and token totals. Grouping starts off. |
| Archive support | Actually read only the 30 most recently archived root tasks by default, plus unarchived tasks. Load all archives explicitly. |
| Time ranges | Select Today, Last 7 days, Current quota period, or Task lifetime. |
| Trends and rankings | Explore daily usage and the top five projects by cost, tokens, or 20x equivalents. |
| Table controls | Explicit full table or simple view, search, filters, column sorting and comfortable/compact density. Full view supports column visibility; simple view selects one metric. |
| Refresh controls | Incremental refresh immediately or every 30 seconds, 1, 2, 5, or 10 minutes; explicitly rebuild statistics for the current scope when needed. |
| Chinese / English | Switch in the top-right corner. New visitors start in English; the last choice is remembered. |
| Task details | Expand previews, paths, and token breakdowns; open tasks in Codex or inspect tracked live runs. |

Language, refresh interval, comparison plan, table view, selected simple-view metric,
column visibility, and density are saved in the current browser. Grouping and archive scope return to their defaults on reload.
Task names, project names, and authored messages are not translated.

## Quick start

You need Node.js and npm, plus an authenticated Codex installation that supports
`codex app-server`. This version has been exercised locally on Windows with
Node.js 24; the repository CI configuration targets Node.js 22. See
[requirements and platform limits](docs/setup-and-reference.md#requirements).

Download or clone this repository, then run from its root:

```bash
npm ci
npm run build
```

Start on Windows PowerShell:

```powershell
$env:CODEX_MONITOR_HOST = '127.0.0.1'
$env:CODEX_MONITOR_DRY_RUN = '1'
npm start
```

Start on macOS or Linux:

```bash
CODEX_MONITOR_HOST=127.0.0.1 CODEX_MONITOR_DRY_RUN=1 npm start
```

Open **[http://127.0.0.1:4201](http://127.0.0.1:4201)**. Keep the terminal running;
press `Ctrl+C` to stop the foreground server. These commands explicitly keep
shutdown actions in simulation mode.

If Codex cannot be found, set `CODEX_MONITOR_CODEX_PATH` to its executable.
No separate API key is required by the dashboard; live account data comes through
your authenticated local Codex installation.

The Windows `.cmd` launcher also defaults to loopback and starts the monitor
in the background. When the standalone per-user copy is installed, it delegates
to its scheduled task so closing Codex does not stop the monitor. See
[standalone Windows deployment](docs/standalone-windows.md) for logon startup,
management, logs, and redeploying updates; no general one-click installer is
currently included. LAN settings can be supplied locally without committing
them. See [Windows launchers](docs/setup-and-reference.md#windows-launchers).

The header stays visible while browsing task details, trends and estimation
methodology. Its links return to the overview, with anchor spacing adapting to
the wrapped header on narrow screens.

## Understand the numbers

| Metric | Meaning | Scope |
| --- | --- | --- |
| Account quota | Overall limit reported by Codex for the currently signed-in account. | Whole account, independent of task filters and the archive limit. |
| Approx. quota % | Observed quota increases allocated to local tasks using their recorded costs. | Current account and quota period only; other selected ranges show `--`. |
| Plan equivalent usage | Selected-period estimated cost divided by calibrated cost per 1% of a Pro 20x week, multiplied by the selected nominal plan ratio. | All included local records, including records from previously used accounts. |
| Estimated cost | API-equivalent USD value of recorded tokens using the built-in model price table. | Selected time range; not a subscription charge or official invoice. |
| Total tokens | Recorded task tokens, including attributable subagents. | Selected time range. |

**One selected plan's weekly allowance is the 100% reference.** Pro 20x, Pro 5x
and Plus multiply the calibrated 20x estimate by 1, 4 and 20 respectively. For example, 250%
means an estimated 2.5 selected-plan weekly allowances over the selected range. It does
not mean the currently signed-in account has used 250% of its own quota.

The estimator assumes recorded Pro accounts are **20x**. Logs identify Pro but
do not reliably distinguish 5x from 20x. The comparison selector changes the reference,
not the recorded account tier; automatic account-tier verification is not available. Mixed tiers, missing logs, usage on other devices,
unpriced models, and tool fees can affect accuracy. The monitor does not sign
into old accounts or retrieve their missing history.

Calibration tracks each task's quota readings separately, allowing normal lag
between parallel clients. Same-task regressions, unknown costs and observation
gaps do not qualify. Concurrent readings are combined; per-window high-water
marks and stable sample identities prevent recounting and fragment collisions.
On sample-format upgrades, the previous reference remains visible while compatible
samples rebuild within the existing archive scope, until five percentage points
qualify. In v0.4.1, sample identities and persisted samples use v3; calibration data
in parser caches upgrades lazily to v4. No cache clearing is required, and the quota-attribution ledger is preserved.
Account quota attribution only allocates increases observed after monitoring
began; earlier usage in the same task can remain unattributed, so it need not equal
the equivalent estimate.

- `--` means unavailable or not yet attributable, not zero usage.
- `+` marks a partial estimate or total.
- Prices are a local table, not a live pricing feed.
- Calibration needs at least five percentage points of usable weekly quota
  observations. A new setup may initially show `--`.

Valid calibration is saved locally and remains visible while replacement samples
accumulate. Already-read calibration samples are retained independently of archive
display scope for 30 days; shrinking the table's scope cannot discard them. New
samples can update the reference even when another account's week starts earlier.
Failed saves retry during subsequent refreshes. Upgrades preserve older calibration
files; a missing reference can be recovered from already-loaded historical metadata.

The overall card identifies Monitor's Codex CLI account, which may differ from the
desktop app account. Temporary failures preserve the last confirmed account snapshot
and update time, visibly marked as stale. Those readings do not create new quota
attribution; a confirmed logout or different account does not inherit old quota.
Initial task statistics refresh as soon as the quota window becomes ready.

Upgrading from the session parser used before v0.2.0 rebuilds cached archive summaries and
starts a fresh quota-attribution baseline. Previously observed account usage
is left unattributed instead of preserving potentially incorrect task shares;
new observations receive task shares from that baseline onward. Recorded tokens,
estimated costs, and 20x equivalents are recalculated from the original logs.

See [metric details](docs/setup-and-reference.md#metric-details) for the calculation
and its limits.

## Dashboard controls

The dashboard separates current-account quota, cross-account estimates, and task
details. Header navigation jumps to the overview, tasks, and trends. The account
card shows its source, remaining quota, and reset time. Range and comparison
controls sit beside the cross-account heading, with separate metric cards below.
Archive scope controls sit beside the task heading; each task shows its project.
Trends and detailed explanations are below the table. Full table is the default at every width,
with horizontal scrolling when necessary. Choose Simple view to show task, one
selected metric, and status; expanding a task reveals its remaining metrics.
Only Full table offers column-visibility controls. The view and simple metric are
remembered. The refresh interval is visible at the top right; More actions contains
refresh status and Rebuild statistics.
Zero quota values are muted; pace differences within five percentage points use
a neutral display.

## Time ranges and archives

The current quota period is selected by default. Today and Last 7 days follow
calendar days on the **monitor computer**. Its timezone is shown beside the range.
Last 7 days includes today and the previous six days. Task
lifetime uses all available history **within the selected archive scope**.

The equivalent-usage total is explicitly labeled **Across accounts**, covering
local records in the selected scope. The current account's quota window defines
the current-period range. Its start, end/reset, and data cutoff are shown
separately; the data cutoff is the statistics timestamp, not the period end.

Cost, tokens, 20x equivalents, project totals, trends, and rankings follow the
selected time range. Previous results keep their original label while the next
range loads. Daily charts show dates with recorded usage; a missing date is not
proof of zero consumption.

The default scope includes all unarchived root tasks and the **30 most recently
archived root tasks**, plus attributable children. Older archive logs are not
fully parsed merely to hide them later. **Calculate all archives** explicitly
expands the scope and can take longer on large histories.

A task keeps its own rollout identity when its log contains inherited parent
metadata. Nested subagent usage is added to its principal task once, without
hiding that task. Temporary log-read failures are retried on the next refresh.

On startup, the monitor loads the selected archive scope once (the default is
the latest 30 archived roots plus unarchived tasks). Subsequent automatic updates
and **Refresh now** reuse unchanged logs and process only appended data for
growing logs. A finished task receives a final tail update before its unchanged
result is reused; new activity continues incrementally. Account quota and active
status continue to update on their own schedules.

**Rebuild statistics** explicitly re-reads logs in the current archive scope.
It does not expand recent archives to all archives or reset saved quota
attribution. Changing the time range, search, sorting, or display filters does
not trigger a full rebuild. Thread metadata is shared across concurrent requests
and cached for up to 60 seconds, so pagination does not repeatedly fetch it.

**Hide archived tasks**, search, row filters, and collapsed groups affect only
the displayed rows. Scope totals, project totals, and rankings still include
all tasks in the selected archive scope. Task lifetime does not automatically
read every archive.

## Local data and network access

The backend defaults to loopback and reads local Codex logs and metadata.
It stores its own caches under `.cache/` without rewriting Codex session logs.
The dashboard does not upload history to an analytics service. Its Codex
app-server connection can use the network through the installed Codex client.

Task details can contain prompts, paths, commands, and other private content.
The server has **no built-in login or TLS**. Origin checks are not authentication
and do not secure a public tunnel. LAN or remote deployment needs separate
access controls; see [network access](docs/setup-and-reference.md#network-access).

Optional shutdown controls are inherited from upstream. The quick start above
and this version's Windows launcher use dry-run mode. Real shutdown uses Windows
`shutdown.exe`; see [shutdown behavior](docs/setup-and-reference.md#shutdown-automation).
Cancellation waits for any in-flight scheduling command. If Windows rejects the
cancel command, the pending shutdown remains visible with an error.

## Development

```bash
npm run dev
npm test
npx tsc --noEmit
npm run build
```

The development backend uses port 4201; Vite normally uses 5173. Stop a running
monitor before starting another backend on the same port.

Built with TypeScript, React, Vite, Express, and WebSocket. See the
[setup and architecture reference](docs/setup-and-reference.md) for configuration,
launchers, troubleshooting, and source layout.

The `tsup` dependency override selects esbuild 0.28.2 or later to address
[GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr).
Keep it until tsup's own dependency range includes the fixed version.

## Credits and license status

Based on [manuelsh/codex-monitor](https://github.com/manuelsh/codex-monitor).
Upstream authors retain credit for the original application. This version adds
the usage-analysis and interface enhancements described above.

No project `LICENSE` file is present in this checkout. This README does not
assign a license to upstream code or claim MIT/Apache licensing. Confirm and
retain the applicable upstream permissions and notices before publishing a
redistributable release.
