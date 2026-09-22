import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { isAllowedBrowserOrigin } from "./http-security";
import { MonitorService } from "./service";

const host = process.env.CODEX_MONITOR_HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "4201");
const serverOrigin = new URL(`http://${host}:${port}`).origin;

const app = express();
const service = new MonitorService();

app.use((request, response, next) => {
  if (!isAllowedBrowserOrigin(request.headers.origin, serverOrigin)) {
    response.status(403).json({ error: "Forbidden origin" });
    return;
  }

  next();
});
app.use(
  cors({
    origin(origin, callback) {
      callback(null, isAllowedBrowserOrigin(origin, serverOrigin));
    }
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/snapshot", (_request, response) => {
  response.json(service.getSnapshot());
});

app.get("/api/runs", (_request, response) => {
  response.json(service.listRuns());
});

app.get("/api/runs/:runId", (request, response) => {
  response.json(service.getRunSnapshot(request.params.runId));
});

app.post("/api/runs/:runId/automation/arm", async (request, response) => {
  try {
    const snapshot = await service.armRunAutomation(
      request.params.runId,
      request.body ?? {}
    );
    response.json(snapshot);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/automation/cancel-shutdown", async (_request, response) => {
  try {
    const snapshot = await service.cancelShutdown();
    response.json(snapshot);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/automation/no-active-sessions/arm", async (request, response) => {
  try {
    const snapshot = await service.armGlobalNoActiveSessionsAutomation(
      request.body ?? {}
    );
    response.json(snapshot);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/automation/no-active-sessions/cancel", async (_request, response) => {
  try {
    const snapshot = await service.cancelGlobalNoActiveSessionsAutomation();
    response.json(snapshot);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/history/threads", async (request, response) => {
  try {
    const sourceKinds =
      typeof request.query.sourceKinds === "string"
        ? request.query.sourceKinds.split(",").filter(Boolean)
        : null;
    const history = await service.listHistoryThreads({
      cursor:
        typeof request.query.cursor === "string" ? request.query.cursor : null,
      limit:
        typeof request.query.limit === "string"
          ? Number(request.query.limit)
          : 20,
      searchTerm:
        typeof request.query.searchTerm === "string"
          ? request.query.searchTerm
          : null,
      sourceKinds
    });
    response.json(history);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/history/jobs", async (request, response) => {
  try {
    const sourceKinds =
      typeof request.query.sourceKinds === "string"
        ? request.query.sourceKinds.split(",").filter(Boolean)
        : null;
    const history = await service.listHistoryJobs({
      archiveMode: request.query.archives === 'all' ? 'all' : 'recent',
      period: request.query.period === 'today' || request.query.period === '7d' || request.query.period === 'lifetime' ? request.query.period : 'quota',
      forceRefresh: request.query.forceRefresh === 'true',
      cursor:
        typeof request.query.cursor === "string" ? request.query.cursor : null,
      limit:
        typeof request.query.limit === "string"
          ? Number(request.query.limit)
          : 20,
      searchTerm:
        typeof request.query.searchTerm === "string"
          ? request.query.searchTerm
          : null,
      sortKey:
        typeof request.query.sortKey === "string" ? request.query.sortKey : null,
      sortDirection:
        typeof request.query.sortDirection === "string"
          ? request.query.sortDirection
          : null,
      sourceKinds
    });
    response.json(history);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

const webDistPath = path.resolve(process.cwd(), "dist/web");
if (existsSync(webDistPath)) {
  app.use(express.static(webDistPath));
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/")) {
      next();
      return;
    }

    response.sendFile(path.join(webDistPath, "index.html"));
  });
}

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ origin }: { origin: string }) =>
    isAllowedBrowserOrigin(origin, serverOrigin)
});

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "snapshot",
      payload: service.getSnapshot()
    })
  );
});

service.on("change", (snapshot) => {
  const payload = JSON.stringify({ type: "snapshot", payload: snapshot });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
});

server.listen(port, host, async () => {
  await service.start();
  console.log(`Codex Monitor API listening on http://${host}:${port}`);
});
