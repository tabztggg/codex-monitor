# Setup and reference

[English overview](../README.en.md) · [中文介绍](../README.zh-CN.md)

Commands run from the repository root. This document describes the current
customized source tree and its optional local launcher configuration.

## Requirements

- Node.js and npm. Use Node.js 22.13 or newer; this checkout has been exercised
  locally with Node.js 24. The package still declares `>=20`, but that declaration
  is not proof that its current SQLite-dependent tests work on Node.js 20.
- An authenticated Codex installation with `codex app-server` support.
- PowerShell 7 for the Windows launchers.
- Read access to the local Codex history you want to analyze.
- Windows is the locally verified platform for this customized dashboard.
  macOS/Linux helpers and a three-platform CI matrix are present; their presence
  does not establish a successful run of this version on those systems.

Archive metadata uses Node's `node:sqlite` when available. If the local index is
unavailable, bounded log-header reads and file activity times provide a fallback.
That fallback can change which archives are considered most recent.

The backend checks explicit executable overrides, `PATH`, supported macOS app
bundles, and supported editor-extension locations. If discovery fails, set
`CODEX_MONITOR_CODEX_PATH` to a verified Codex executable. The Windows convenience
launcher also looks for the desktop app's versioned bundled executable.

## Start and stop

Install dependencies and build:

```bash
npm ci
npm run build
```

PowerShell 7:

```powershell
$env:CODEX_MONITOR_HOST = '127.0.0.1'
$env:CODEX_MONITOR_DRY_RUN = '1'
npm start
```

macOS / Linux:

```bash
CODEX_MONITOR_HOST=127.0.0.1 CODEX_MONITOR_DRY_RUN=1 npm start
```

Open [http://127.0.0.1:4201](http://127.0.0.1:4201). Stop the foreground process
with `Ctrl+C`. Rebuild and restart after backend updates; refresh the browser
after frontend updates. Do not start two servers on the same address and port.

`GET /api/health` returning `{"ok":true}` proves the HTTP service is up.
Also check **Connected** beside the task refresh controls and the account quota
card: HTTP health alone does not prove Codex authentication or connectivity.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4201` | HTTP and WebSocket port. |
| `CODEX_MONITOR_HOST` | `127.0.0.1` | Backend bind address; takes precedence over the Windows launcher's local host file. |
| `CODEX_MONITOR_ALLOWED_ORIGINS` | empty | Comma-separated extra HTTP/HTTPS page origins for reverse proxies and tunnels; exact matches only. |
| `CODEX_HOME` | `~/.codex` | Existing Codex home used for history and metadata. |
| `CODEX_MONITOR_CODEX_PATH` | unset | Explicit Codex executable path. |
| `CODEX_BIN` | unset | Alternate executable override. |
| `CODEX_MONITOR_DRY_RUN` | platform/environment dependent | `1` / `true` simulates shutdown; `0` / `false` requests real Windows commands. Explicitly use `1` for monitoring-only operation. |

The application reads the process environment; it does not automatically load
a `.env` file. The built UI uses its serving origin. The development proxy in
`web/vite.config.ts` targets port 4201; changing the development backend port
also requires updating its HTTP and WebSocket targets.

## On-demand launchers

The root Windows entry installs an independent background copy, desktop shortcut
and logon task. The macOS/Linux helpers are on-demand launchers.

### Windows launchers

Double-click `Codex Monitor.vbs` in the repository root. It invokes PowerShell 7
without a console window. First launch installs dependencies, builds and deploys;
later launches start/open the installed copy and repair a missing desktop shortcut.

```powershell
wscript.exe '.\Codex Monitor.vbs'
wscript.exe '.\Codex Monitor.vbs' nobrowser
wscript.exe '.\Codex Monitor.vbs' deploy
```

Deployment uses `scripts/Install-StandaloneMonitor.ps1`, creates and verifies the
desktop shortcut, and registers a windowless task at user logon. Closing Codex
does not stop Monitor. Old Monitor lifecycle hooks are backed up and removed.
The website can restart/stop a managed Monitor; after stopping, use the desktop
shortcut to start it again. Helpers and retired entry points remain under
`scripts/` and `scripts/legacy/`. See [standalone Windows deployment](standalone-windows.md)
for installed paths, configuration, logs and updates.

### macOS and Linux launchers

```bash
sh scripts/start-codex-monitor.sh
sh scripts/start-codex-monitor.sh --no-browser
sh scripts/start-codex-with-monitor.sh
sh scripts/start-codex-with-monitor.sh --cli
sh scripts/install-codex-launcher-shortcut.sh
```

These helpers use standard shell tools and loopback health checks. They build
if the server or web bundle is missing and detect conflicting ports where
supported utilities are available. They do not install a login service.
On macOS, a supported signed-in Codex/ChatGPT app bundle can supply Codex.
The shortcut installer creates a desktop `.command` file on macOS and `.desktop`
entries on Linux. Fresh end-to-end verification of these inherited helpers on
those systems remains outstanding.

## Metric details

### Recorded usage and costs

The reader processes JSONL in chunks and consolidates attributable subagents
into root tasks. Repeated events and unchanged cumulative token counters do not
add usage again. A rollout present in both active and archived directories is
counted once, preferring the active copy. Children that cannot be merged into a
retained parent remain separate tasks rather than disappearing from totals.

The built-in table in `server/src/history-jobs.ts` estimates input, cached input,
cache-write, and output costs, with the implemented context multipliers.
Prices are not fetched dynamically. Priced GPT-6 Astra, Sol and Luna usage is
included; unknown models remain unpriced and tool fees are excluded. These are
API-equivalent estimates, not subscription bills. Overview token breakdowns show
input and output separately; cached input is a subset of input, not extra tokens.

### Account selection and task quota

The overview shows only Monitor's current Codex CLI account, preferring its
weekly quota window and excluding Spark. It shows the full period, snapshot
time and source; this login may differ from the Codex desktop app. The task-page
account selector can use a saved account snapshot without changing either login.

The paired task quota column has fixed scopes:

- **Selected account · This period:** recorded quota increases allocated within that account's quota
  window; a historical account uses its last recorded window.
- **Across accounts · Task lifetime:** all retained local periods/accounts for
  that task and its attributed children.

The selected account replays quota snapshots and allocates each observed increase
using same-interval response cost weights, with token weights for unpriced records.
Cross-account usage first uses recorded quota allocations, then estimates uncovered
priced records with a retained Pro 20x reference. Plan comparison scales both values; each side has an independent sort control. Project totals
include hidden rows. Changing the time range does not change these two scopes.

Rollouts lack reliable account IDs. Records are matched by weekly reset time,
allowing 60 seconds of timestamp drift; records from other windows are excluded.
This is an account-identity estimate: accounts sharing the same reset time cannot
be distinguished. Missing windows, unpriced models and untimed usage make the
result incomplete (`+`), or unavailable (`--`) when no quota or priced evidence exists.
No current-week usage is zero only when the records establish that absence.
The selected account label comes from the same quota snapshot as the calculation.

Account reconciliation shows included tasks + tasks outside the current archive
scope + unattributed quota = official account used. Unpriced records can participate
by token weight without inventing USD prices. Their allocation is labeled approximate
and is already included in task totals. Initial consumption, missing usage records,
unknown account windows, gaps over 30 minutes and corrections remain unassigned.
Cached sample metadata enables replay after pricing updates without
rereading transcripts. Filters do not change the reconciliation totals.
The old `.cache/quota-attribution.json` ledger remains only for compatibility
with quota snapshots that lack an account identity.

### Pro 20x equivalents

The estimator assumes all recorded Pro accounts are 20x; logs do not verify that
assumption or reliably distinguish Pro 5x/20x. Account badges show only the API's
plan label. The comparison selector offers Pro 20x, Pro 5x and Plus at factors
of 1, 4 and 20; it does not change or verify the account's actual tier.

Calibration uses the selected account's replayable observations in its quota
window, from metadata retained for 30 days. Parallel sessions are merged into
one timeline. At least five percentage points and 90% coverage of quota increases
and matching usage weights are required. Mixed intervals retain known prices and
estimate the unpriced share by token weight; partial references are labeled approximate. A narrow surviving subset
does not replace the reference. Older account windows cannot replace a newer
scoped reference. Historical manual references may remain the common comparison
unit while evidence is insufficient, labeled as retained rather than current.
Manual overrides apply only to their recorded account and matching reset period.

At least five usable percentage points are required. Initial balances do not
count as consumption. Reset changes and gaps over 30 minutes restart observation
baselines; unusable corrections or missing usage evidence invalidate affected intervals.
Stale snapshots cannot recount a return to the preceding high-water mark.
See `server/src/quota-equivalent.ts` for the implementation.

When observations are insufficient, the previous reference remains visible
while calibration updates. An optional adjacent `.manual.json` calibration
override requires `version: 1`, positive `costPerPercent`, `accountId` (the
saved account's opaque display ID), `resetsAt` (ISO timestamp), and `updatedAt`
in milliseconds within that week. It takes precedence only for that account
and active period; otherwise it can be retained as a historical comparison
reference. It changes cross-account equivalents only, not task allocations,
costs or tokens. Official account totals are not forced onto tasks.

Selected-range summaries, daily trends and rankings use the same quota slices
and estimate only uncovered priced usage with this reference. One
20x week always equals 100%; this is not a share of total consumption, and several
weeks of usage can exceed 100%. Records from formerly used
accounts count only where available locally and within the archive scope.
The monitor does not authenticate into old accounts or retrieve missing logs.

Applying a current calibration to older history remains an estimate. Model mix,
pricing, tier differences, rounding, tools, and other-device activity affect it.

### Time ranges and missing data

| Range | Boundary |
| --- | --- |
| Today (default) | Midnight today on the monitor computer through now. |
| Last 7 days | Midnight six calendar days ago through now; includes today. |
| Task lifetime | All recorded history for included tasks. |
| Custom dates | Start-day midnight through the end of the selected end date, capped at now. |

Cross-account summary equivalents, cost, tokens, trends and rankings follow this
range. Task quota retains the two fixed scopes described above. Missing
timestamps cannot be assigned to calendar periods and are reported in the
estimation panel. Unknown values are `--`; partial results carry `+`. Daily
trends show recorded dates, without interpreting a missing date as zero usage.

The **Today row filter** is separate from the **Today time range**: the former
filters task activity, while the latter changes usage totals. Both use the
Monitor's time zone. Overview current activity is live state, independent of the
historical date range. The task count in overview totals counts tasks with
recorded consumption, not every included task.

### Archives and totals

The read-only Codex index selects the latest 30 archived roots before full log
parsing. All unarchived roots and attributable children remain included.
The fallback uses bounded header reads and file activity timestamps.

Only **Calculate all archives** expands coverage. Previous results remain
visible while loading; failures can be retried explicitly, and the page can
return to recent mode. Reloading defaults to recent mode. A longer time range
does not automatically select more archives.

Project totals, scope totals, and rankings include hidden rows in that scope.
Search, row filters, and grouping do not change those totals. The global account
card is broader: it covers the account regardless of local history coverage.

Archived and daily summaries are cached in `.cache/archived-history.json`.
Unchanged included logs can reuse them after restart. Invalid caches are rebuilt
from selected source logs without editing the logs or silently scanning all archives.

### Refresh and preferences

Task refresh defaults to 10 minutes after the preceding request completes.
Options are 30 seconds, 1, 2, 5, 10, 30, and 60 minutes. Older fast preferences
migrate to 10 minutes once; later choices are preserved. Manual refresh resets
the deadline; changing the interval also refreshes immediately. The frontend
cancels superseded requests and publishes all pages together. Failures retain
old data with an error. A failed all-archive request requires explicit retry.

Hidden pages cancel scheduled statistics/detail polls and the dashboard clock.
An in-flight read can finish; returning fetches once if overdue, without duplicate
requests. Expanded official details refresh every 10 minutes, with one 30-second
follow-up if the provider is still refreshing a cached result. Metadata is cached
for 10 minutes. The ordinary dashboard clock ticks once a minute, not once a second.

Account quota polls every 5 minutes; active sessions poll every minute.
Arming shutdown automation first reconciles current activity, then enables
2-second activity checks and a visible 1-second countdown until disarmed.
Account-change notifications still trigger an immediate identity/quota read.
Live snapshots arrive over WebSocket. Task refresh settings do not alter those
backend schedules. Language, interval, columns, and density are remembered in
browser storage, separately for each browser and origin. New visitors use
English. Grouping starts off and archive mode starts at recent on each page load.

## Network access

The backend defaults to `127.0.0.1`. `CODEX_MONITOR_HOST` can bind to a specific
LAN address that exists on the host. Adapt the address to the actual machine.

HTTP and WebSocket accept loopback origins, the configured HTTP server origin,
and explicitly configured extra origins. Requests without an `Origin` header are also allowed. There is no built-in
login, API token validation, or TLS; these origin checks are not authentication.

Task information and automation controls are accessible to clients that can
reach the service. Remote deployment needs its own authenticated access boundary
and network restrictions. Public tunnel domains are not automatically accepted.
Set the page's external origin in `CODEX_MONITOR_ALLOWED_ORIGINS`, for example:

```powershell
$env:CODEX_MONITOR_ALLOWED_ORIGINS = 'https://monitor.example.com'
npm start
```

If both HTTP and HTTPS are used, list both explicitly, separated by commas.
Scheme, hostname and port must match; subdomains and other ports are not included.
Outer whitespace and a single trailing slash are accepted. Paths, credentials,
queries, fragments, wildcards and empty entries are rejected at startup.
The same rule protects static assets, APIs, CORS responses and `/ws` upgrades.
The server does not trust `Host` or forwarded headers to extend the allowlist.
The frontend uses its page's origin and automatically selects `ws` or `wss`.
The proxy must forward WebSocket upgrades to the same backend port. Restart
after configuration changes. For the Windows standalone installation, use its
[`allowedOrigins` configuration](standalone-windows.md#reverse-proxy-or-tunnel)
instead of setting the variable in an unrelated terminal.

The maintainer's machine-specific firewall helper is excluded from the
repository. Firewall rules and tunnel configuration are not installed by these
launchers; configure those for the actual network when needed. Localhost use
does not need a firewall exception or port forwarding.

## Shutdown automation

Automation is disabled by default and settings are held in memory. The quick
start and current Windows launcher set `CODEX_MONITOR_DRY_RUN=1`, so arming a
rule there simulates the shutdown action.

Without an override, simulation is the default except on Windows with
`NODE_ENV=production`. Explicit `0` / `false` enables Windows command execution.
macOS/Linux have no native shutdown implementation; forcing execution there
does not create one. Global controls are in the expandable footer; tracked runs
have their own controls. Restarting resets automation settings. A successful
dry run does not verify real shutdown.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `spawn EPERM` on Windows | A restricted parent shell may be unable to start Codex. Use a normal terminal and check connection status. |
| Codex not found | Check `codex --version` in your normal shell or set `CODEX_MONITOR_CODEX_PATH`. |
| HTTP healthy but quota missing | Check Codex login, app-server connectivity, and available account-limit data. |
| Windows shortcut fails to bind | Check the host environment override and local host file; the chosen address must exist on the machine. |
| 20x shows `--` | Calibration or priceable usage may be missing, or observations may be insufficient. |
| Task totals differ from account consumption | Account usage includes activity outside the selected local history and archive scope. |
| Filters do not change totals | Displayed rows are intentionally separate from the statistics scope. |
| Full-archive scan is slow | Large histories need parsing. Recent mode limits this work. |
| Updated UI is not visible | Rebuild, refresh, and verify the page points to the intended server. |
| LAN works but tunnel page is blank or live connection fails | Add the exact external HTTP/HTTPS origin to the allowlist and restart; check proxy WebSocket forwarding. |

## Run in development

```bash
npm run dev
```

The backend defaults to port 4201. Vite normally uses 5173; read its terminal
output if that port is occupied. Before submitting code changes:

```bash
npm test
npx tsc --noEmit
npm run build
git diff --check
```

For documentation-only edits, check commands against source and validate links.
A running server does not need restarting for Markdown edits.

## Platform verification

The v0.4.12 validation on 2026-09-28 used Windows: 624 tests passed and 2 were
skipped; TypeScript and production build passed. The README screenshots use the
actual build with fictional data. These results do not verify every platform,
physical mobile device or future commit.

`.github/workflows/ci.yml` targets Windows, macOS, and Linux with Node.js 22,
including POSIX shell syntax checks. A configured workflow does not establish
that a run has completed on a newly published fork.

## Privacy model

Local inputs include `sessions/`, `archived_sessions/`, the session title index,
Codex state database, and saved project metadata beneath the Codex home. Live
information comes from the installed Codex app-server.

Original logs are not rewritten. The monitor's own caches contain task metadata
and usage details and must remain private. Logs and screenshots can contain
prompts, paths, account information, or project names. Do not attach raw history
or caches to public bug reports.

## Architecture

| Location | Responsibility |
| --- | --- |
| `server/src/index.ts` | Express API, static frontend, WebSocket, origin checks. |
| `server/src/service.ts` | Codex integration, polling, state coordination. |
| `server/src/history-jobs.ts` | Session parsing, archive selection, costs, daily summaries, parent consolidation. |
| `server/src/quota-attribution.ts` | Persistent observed current-account allocation. |
| `server/src/quota-equivalent.ts` | Pro 20x calibration and conversion. |
| `server/src/archive-metadata.ts` / `project-metadata.ts` | Local archive and project metadata. |
| `web/src/components/HistoryPanel.tsx` | Controls, ranges, grouping, sortable table. |
| `web/src/components/TaskInsights.tsx` | Scope totals, trends, project rankings. |
| `web/src/localization.ts` | English/Chinese messages and formatting. |
| `shared/monitor.ts` / `usage-period.ts` | Shared types and period helpers. |

## Repository hygiene

`.gitignore` excludes dependencies, builds, runtime logs, `.env` files, local
Codex/browser state, and `.cache/`. Ignore rules do not remove already tracked
files or data in Git history.

Review intended files and history before publishing. Existing images in
`assets/` include legacy dashboard screenshots; review and redact them separately.
The new README does not present these as current-version screenshots. The
two dashboard images retained from upstream have blurred task names/content.

Retain upstream attribution and resolve missing project-license metadata before
describing a release as freely redistributable. The Chinese
[release notes](github-release.zh-CN.md) summarize the latest changes and upgrade steps.
