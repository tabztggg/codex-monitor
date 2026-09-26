# Setup and reference

[English overview](../README.en.md) · [中文介绍](../README.md)

Commands run from the repository root. This document describes the current
customized source tree and its optional local launcher configuration.

## Requirements

- Node.js and npm. Use Node.js 22 or newer; this checkout has been exercised
  locally with Node.js 24. The package still declares `>=20`, but that declaration
  is not proof that its current SQLite-dependent tests work on Node.js 20.
- An authenticated Codex installation with `codex app-server` support.
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

Windows PowerShell:

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

The repository includes background launchers and shortcut installers. Running
the standard launchers does not itself install an automatic login service.
Background launchers write `codex-monitor.out.log` and `codex-monitor.err.log`
in the repository root. Dependencies must already be installed.

### Windows launchers

`scripts/Start-CodexMonitor.ps1` defaults to `127.0.0.1` and forces
`CODEX_MONITOR_DRY_RUN=1`. Host selection, in priority order:

1. `CODEX_MONITOR_HOST` in the environment.
2. A single IPv4 address in `.cache/launcher-host.txt`, if present.
3. `127.0.0.1`.

The optional host file is ignored by Git and stays on the local machine. It
lets desktop and login shortcuts retain a LAN address without publishing it.
The Windows launcher validates IPv4 addresses before starting any process.

It starts Node hidden, locates Codex, waits for HTTP health, and optionally opens
the browser. `-NoBrowser` suppresses the browser. An existing listener is reused
only after it is verified as Node serving a dry-run monitor; an unrelated port
owner is not stopped. It builds only if the server bundle is missing, so build
explicitly after source changes or when frontend output is missing.

Its entry points are:

```powershell
wscript.exe '.\Codex Monitor.vbs'
wscript.exe '.\Codex Monitor.vbs' nobrowser
& '.\scripts\legacy\Codex With Monitor.cmd' -Cli
```

`scripts/legacy/Install Desktop Shortcut.cmd` creates a monitor shortcut. The separate Codex
launcher shortcut starts the monitor and then Codex. For login startup, place
a shortcut to a reviewed launcher in `shell:startup`; this is per-machine setup,
not something installed by cloning the repository. `-NoBrowser` avoids opening
a page at login.

The legacy **Install Codex Process Trigger.cmd** creates a Scheduled Task and
enables Windows process-creation auditing with administrator rights. Its
uninstaller removes the task but leaves auditing enabled. This is separate
from login startup and is not required for the dashboard.

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
into root tasks. Repeated token events are suppressed when unchanged cumulative
counters prove no new usage. A rollout present in both active and archived
directories is counted once, preferring the active copy. Missing parent metadata
can prevent child attribution.

The built-in table in `server/src/history-jobs.ts` estimates input, cached input,
cache-write, and output costs, with the implemented context multipliers.
Prices are not fetched dynamically. Unknown models remain unpriced and tool
fees are excluded. These are API-equivalent estimates, not subscription bills.

### Current-account equivalents

The header selects the overall Codex bucket, preferring its weekly window and
excluding Spark. **Current account %** replaces the former observed-quota
allocation column. It divides matched task costs by the same saved Pro 20x
calibration used for cross-account equivalents. It always covers the current
weekly period, even when another time range is selected. Plan comparison scales
both columns; project totals include hidden task rows.

Rollouts lack reliable account IDs. Records are matched by weekly reset time,
allowing 60 seconds of timestamp drift; records from other windows are excluded.
This is an account-identity estimate: accounts sharing the same reset time cannot
be distinguished. Missing windows, unpriced models and untimed usage make the
result incomplete (`+`), or unavailable (`--`) when no priced subtotal exists.
No current-week usage is zero only when the records establish that absence.
The current account label comes from the same quota snapshot as the calculation.

The old `.cache/quota-attribution.json` ledger is preserved for compatibility;
its observed increment allocation no longer drives the table column.

### Pro 20x equivalents

The estimator assumes all recorded Pro accounts are 20x; logs do not verify that
assumption and there is no tier selector. Local rate-limit observations from
the current weekly window calibrate API-equivalent cost per percentage point,
after merging parallel sessions into one timeline.

At least five usable percentage points are required. Initial balances do not
count as consumption. Reset changes and gaps over 30 minutes restart observation
baselines; unusable corrections or missing prices invalidate affected intervals.
Stale snapshots cannot recount a return to the preceding high-water mark.
See `server/src/quota-equivalent.ts` for the implementation.

Selected-range costs are divided by this reference. One 20x week always equals
100%; several weeks of usage can exceed 100%. Records from formerly used
accounts count only where available locally and within the archive scope.
The monitor does not authenticate into old accounts or retrieve missing logs.

Applying a current calibration to older history remains an estimate. Model mix,
pricing, tier differences, rounding, tools, and other-device activity affect it.

### Time ranges and missing data

| Range | Boundary |
| --- | --- |
| Current quota period | Current account reset window through the snapshot time. Default. |
| Today | Midnight today on the monitor computer. |
| Last 7 days | Midnight six calendar days ago through now; includes today. |
| Task lifetime | All recorded history for included tasks. |

Cost, tokens, 20x, summaries, trends, and rankings follow this range. Missing
timestamps cannot be assigned to calendar periods and are reported in the
estimation panel. Unknown values are `--`; partial results carry `+`. Daily
trends show recorded dates, without interpreting a missing date as zero usage.

The **Today row filter** is separate from the **Today time range**: the former
filters task activity, while the latter changes usage totals. Row filters use
the browser's local day; usage periods use the monitor computer's timezone.

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

Task refresh defaults to 30 seconds after the preceding request completes.
Options are 30 seconds, 1, 2, 5, and 10 minutes. Manual refresh resets the
countdown; changing the interval also refreshes immediately. The frontend
cancels superseded requests and publishes all pages together. Failures retain
old data with an error. A failed all-archive request requires explicit retry.

Account quota polls every 60 seconds; active sessions poll every 2 seconds.
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

The feature validation on 2026-09-22 used Windows and Node.js 24: 129 tests passed
and 2 were skipped; TypeScript and production build passed. Desktop-browser
checks covered ranges, trends, grouping, hidden archives, column settings,
density, language persistence, refresh, and sorting. These are results of that
run, not guarantees for every machine or later commit. A physical mobile-device
check was not performed.

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
