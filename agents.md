# Codex Monitor Agent Notes

## Project Shape

Codex Monitor is a TypeScript app with an Express/WebSocket backend and a React/Vite frontend.

- `server/src/` contains the API server, Codex app-server client, active session tracking, automation logic, storage, and usage parsing.
- `web/src/` contains the dashboard UI, API client, shared state hook, and React components.
- `shared/monitor.ts` contains the shared snapshot, run, thread, automation, and usage types used by both server and web code.
- `scripts/` contains Windows PowerShell and macOS/Linux shell helpers for starting the monitor and installing on-demand launchers.
- `dist/` is generated build output. Do not edit it directly unless the task explicitly requires regenerated artifacts.

## Commands

- `npm run dev` starts the backend watcher and Vite frontend.
- `npm run build` builds the server and web app into `dist/`.
- `npm start` runs the built server from `dist/server/index.js`.
- `npm test` runs the Vitest test suite.

## Change Guidelines

- Keep server, web, and shared type changes aligned. If a snapshot shape changes, update all consumers in the same change.
- Prefer focused tests for automation, store, service, client, active-session, and usage behavior when those areas change.
- After implementation changes, run `npm test` when practical. Run `npm run build` for changes that touch TypeScript, server bundling, or frontend rendering.
- Keep `README.md` current whenever changes affect architecture, setup, commands, runtime behavior, UI behavior, shutdown automation, configuration, or user-facing workflows. Do not let documentation drift from the implementation.

## Windows deployment acceptance

Use the root `Codex Monitor.vbs` entry (`deploy` to install/update). Helper scripts are under `scripts/`; old CMD entry points are under `scripts/legacy/`. For Windows deployment, run `Install-StandaloneMonitor.ps1` and verify the actual user's Desktop `Codex Monitor.lnk`, logon task, and HTTP health. A build alone is not deployment. Never report deployment complete when the shortcut is missing or points at a nonexistent launcher.
