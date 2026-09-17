# Setup and reference

[Back to the dashboard overview](../README.md)

Commands below run from the repository root.

## Requirements

- Node.js 22 or newer is recommended; the package declares Node.js 20 as its
  minimum and the CI matrix uses Node.js 22.
- npm.
- A working Codex executable that supports `codex app-server`.
- macOS/Linux launcher scripts use standard shell tools. Node.js is used for health checks, and `open` or `xdg-open` is used to open the dashboard.

Codex Monitor respects executable overrides first, then looks for Codex in `PATH`. On macOS it also checks `~/Applications` and `/Applications` for the executable bundled in `Codex.app` or `ChatGPT.app`, before falling back to the VS Code ChatGPT extension location. You can override the executable path with `CODEX_MONITOR_CODEX_PATH` or `CODEX_BIN`.

## On-Demand Launchers

The standard launchers do not register a login/startup service. They start Codex Monitor on demand; Windows also has a separately installed, optional process trigger described below.

The monitor launchers start the built server in the background, write `codex-monitor.out.log` and `codex-monitor.err.log` in the repository root, and open `http://127.0.0.1:4201`. The macOS/Linux launcher builds if either the server or web build is missing; the Windows launcher checks only for the server build. Run `npm ci` first. On macOS/Linux, the launcher waits for a successful health check and exits with an error if the port is occupied by another service or startup fails. After pulling changes, run `npm ci` and `npm run build`, then restart the monitor to load backend changes.

### Windows

Run `Install Desktop Shortcut.cmd` once to create a desktop shortcut that launches only Codex Monitor.

Run `Install Codex Launcher Shortcut.cmd` once to create a desktop shortcut named `Codex with Monitor` and a Start Menu shortcut named `Codex`. Those shortcuts start Codex Monitor silently and then open the installed Codex desktop app.

If you want the normal Codex app launch to start the monitor too, run `Install Codex Process Trigger.cmd` once. It creates a current-user Scheduled Task that listens for Windows process-creation events for the installed Codex executables and starts Codex Monitor only when Codex starts. This does not keep a Codex Monitor process resident before Codex launch, but it requires administrator approval because the installer enables Windows process creation auditing.

Run `Uninstall Codex Process Trigger.cmd` to remove that Scheduled Task. It leaves the Windows audit policy unchanged.

You can also run the launchers directly:

```powershell
& ".\Codex Monitor.cmd"
& ".\Codex Monitor.cmd" -NoBrowser
& ".\Codex With Monitor.cmd" -Cli
```

### macOS And Linux

On macOS, install Node.js first if it is missing, for example with `brew install node@22`, then run `npm ci` and `npm run build` in this repository. The launchers discover Node in standard Homebrew and official-installer locations even when launched from Finder with a minimal `PATH`. Other Node installations must be available in `PATH`.

A Codex desktop installation that bundles `Contents/Resources/codex` is sufficient; a separate CLI install is not required. Keep the desktop app signed in so usage limits are available.

Start only the monitor:

```bash
sh scripts/start-codex-monitor.sh
sh scripts/start-codex-monitor.sh --no-browser
```

Start Codex with the monitor on demand:

```bash
sh scripts/start-codex-with-monitor.sh
sh scripts/start-codex-with-monitor.sh --cli
```

The Codex launcher opens a discoverable Codex desktop app when possible (including ChatGPT on macOS when it bundles Codex). If no desktop app is found, it falls back to the `codex` CLI resolved from executable overrides, `PATH`, or the bundled macOS executable.

Install a desktop launcher:

```bash
sh scripts/install-codex-launcher-shortcut.sh
```

On macOS this creates `~/Desktop/Codex with Monitor.command`. On Linux it creates `codex-with-monitor.desktop` under `${XDG_DATA_HOME:-~/.local/share}/applications` and `Codex with Monitor.desktop` under `${XDG_DESKTOP_DIR:-~/Desktop}` when that folder exists. The Linux desktop launcher allows a terminal so CLI-only Codex installs remain usable.

## Configuration

| Variable                   | Default                                                                            | Purpose                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `PORT`                     | `4201`                                                                             | Backend HTTP/WebSocket port; also respected by the launchers. |
| `CODEX_HOME`               | `~/.codex`                                                                         | Codex home directory used for session history.                                  |
| `CODEX_MONITOR_CODEX_PATH` | unset                                                                              | Absolute path to the Codex executable.                                          |
| `CODEX_BIN`                | unset                                                                              | Alternate Codex executable override.                                            |
| `CODEX_MONITOR_DRY_RUN`    | dry-run unless `NODE_ENV=production` on Windows; dry-run by default on macOS/Linux | Set `1`/`true` to simulate shutdown, or `0`/`false` to execute Windows commands. The Windows launcher explicitly sets `0`. |

The development proxy in `web/vite.config.ts` targets port 4201 explicitly. If
you change `PORT` in development, update both its HTTP and WebSocket targets.
The built UI uses its serving origin and needs no proxy change.

## Shutdown Automation

Shutdown automation is disabled by default. Direct `npm start` and development runs use dry-run mode unless the environment overrides it; on Windows, `NODE_ENV=production` enables real commands by default.

Real shutdown scheduling is implemented with Windows `shutdown.exe`. macOS and Linux default to dry-run mode even in production, so the dashboard can show what would be scheduled without attempting a platform-specific shutdown command.

The Windows launcher starts in production mode, explicitly sets
`CODEX_MONITOR_DRY_RUN=0`, and may restart
an existing dry-run monitor. For a Windows simulation, start the monitor
directly with `CODEX_MONITOR_DRY_RUN=1` instead of using that launcher. Setting
`0` on macOS/Linux does not add native shutdown support: it attempts the same
Windows executable and fails.

Expand **Auto shutdown** in the footer to enable or disable the global rule.
Tracked-run details retain their own arm/cancel controls. Automation settings
are held in memory and reset when the monitor process restarts.

## Troubleshooting

If the **Overall Codex usage** section or the error banner reports `spawn EPERM` on Windows, Codex Monitor was usually started from inside a Codex sandboxed shell or task. The monitor can still read local session history, but Windows blocks that sandboxed process from launching `codex app-server`, so live thread metadata and usage limits are unavailable.

Start the monitor from a normal PowerShell/cmd prompt, the generated desktop launcher, or the Start Menu shortcut instead:

```powershell
& ".\Codex Monitor.cmd"
```

You can confirm the Codex side separately by running `codex app-server` in a normal terminal. It should start without `Access is denied`; press `Ctrl+C` to stop it.

## Metric details

The dashboard preserves three per-task metrics:

| Metric | Period | Meaning |
| --- | --- | --- |
| Estimated total cost | Task lifetime | API-equivalent USD cost of priceable recorded tokens. |
| Total tokens | Task lifetime | Total tokens recorded for the task and attributable subagents. |
| Approx. usage % | Since reset | Share of the primary quota period exposed by the allocation endpoint. |

Prices come from the built-in table in `server/src/history-jobs.ts`, not a live
pricing feed. The calculation accounts for input, cached input, cache writes,
output, and long-context multipliers. A `+` marks a partial lower bound when
some model usage cannot be priced. These are not plan charges and exclude
tool-call fees.

Only observed quota increases are allocated, proportional to each task's
API-equivalent cost recorded since the preceding increase. Unchanged rounded
quota readings keep the pending usage until the next increase. Assigned values
accumulate and never get redistributed to newer tasks. The first reading is a
baseline: prior consumption stays unattributed. Increments without weights or
with unpriced activity also stay unattributed. The table shows observation start
and unattributed quota; zero means no attributed consumption during observation,
not proof of zero historical consumption. Unavailable values display `--`.
The ledger is atomically persisted in `.cache/quota-attribution.json` relative to
the working directory and survives restarts. A changed quota window or a lower
usage reading starts a fresh baseline (including an early reset). Quota polling
and notifications record observations without requiring an open dashboard.
Nested subagent usage is consolidated into its principal task when the parent
chain is available; legacy sessions without parent metadata cannot be attributed.

The header explicitly selects the overall `codex` bucket, preferring its weekly
window; Spark is never a fallback. Its pace message compares quota used with
time elapsed in percentage points, rather than projecting future consumption.
Per-task allocation uses the same overall quota window as the header, preferring
weekly and excluding Spark.
Missing or expired header data is labeled instead of presented as current.

Task history refreshes 30 seconds after each completed attempt. Global quota is
polled every 60 seconds and active sessions every 2 seconds, with live changes
sent over WebSocket. Failed history refreshes retain the previous figures and
show a warning. Filters, sorting, and expanded details survive refreshes.

Today uses the browser's local day and includes active tasks. Highest usage
sorts by quota share, then total estimated cost when shares are tied or missing.
All covers principal tasks available in local session history; the table shows
30 at a time. Search matches readable titles, paths, and task IDs. Narrow screens
use horizontal scrolling to keep every metric accessible.


## Run In Development

```bash
npm run dev
```

The backend runs on `http://127.0.0.1:4201`.
The Vite UI runs on `http://127.0.0.1:5173` and proxies API/WebSocket traffic to the backend. If port 5173 is occupied, Vite may choose the next available port; use the URL printed in the terminal. Stop an existing monitor on port 4201 before starting the development backend.

## Platform Verification

The same source tree and lockfile are used on Windows, macOS, and Linux. GitHub Actions is configured to run the test suite, TypeScript check, and production build on all three systems with Node.js 22; POSIX launcher checks run on macOS/Linux. Windows shutdown commands are covered with mocked command execution, never by shutting down a CI machine.

For a local smoke test, start the monitor and check `/api/health`, then confirm the dashboard shows **Connected** in the footer, your tasks under **Today** or **All**, and available overall usage limits. Check **Active** for work currently running. Usage requires an authenticated Codex installation. A successful HTTP health check alone does not establish that Codex is connected.

The redesigned dashboard was verified on macOS with a connected backend and
WebSocket, automatic task-metric updates, mouse/keyboard expansion, and a
production build. Windows and Linux launcher behavior was reviewed in source;
this local verification does not establish a successful run on either platform.
macOS/Linux shutdown remains a simulation, not a native shutdown feature.

To add the checkout to Codex, use the app's project/folder picker and select this repository's directory. Cloning or launching the monitor does not register a saved project automatically.

## Privacy model

Codex Monitor is designed for local use only.

- The backend binds to `127.0.0.1`.
- The browser API and WebSocket reject non-loopback `Origin` headers.
- The dashboard does not upload its snapshots or local history to third-party
  services. It queries the installed Codex app-server for live status and account
  usage; that Codex installation can communicate with OpenAI.
- It reads local Codex session files from `~/.codex/sessions` or `$CODEX_HOME/sessions`.
- Dashboard data can include prompt previews, working directories, command summaries, session IDs, and usage counters, so do not expose the server through a public proxy.

## Architecture

The application has a backend, a frontend, and shared types:

- `server/src/index.ts` exposes the Express API, serves the built web app, and broadcasts live snapshots through `/ws`.
- `server/src/service.ts` coordinates the Codex app-server client, active session polling, history parsing, usage polling, and shutdown automation.
- `server/src/store.ts` keeps the live run, thread, turn, item, and pending-request state in memory.
- `server/src/history-jobs.ts` reads local Codex JSONL session files from `~/.codex/sessions` and derives previous-work metrics.
- `web/src/` renders the dashboard from the initial `/api/snapshot` response plus WebSocket updates.
- `shared/monitor.ts` defines the shared snapshot, run, thread, history, automation, and usage types used by both sides.

## Repository Hygiene

Generated and local-only files are intentionally ignored:

- `node_modules/`
- `dist/`
- `*.log`
- `.env` and `.env.*` (except `.env.example`)
- `.codex/`
- `.playwright-mcp/`
- test/build caches

Before committing changes, review the diff and run the checks:

```bash
git status --short
git diff --check
npm test
npx tsc --noEmit
npm run build
```

Check `git status --ignored --short` if you want to confirm that logs, build output, dependencies, and local Codex state are excluded.
