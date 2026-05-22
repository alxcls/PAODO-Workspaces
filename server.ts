// Custom Node.js entry point that runs Next.js on a manually created HTTP server.
// This is needed to co-host a WebSocket server on the same port: upgrade requests
// to /ws are routed to the app's WebSocket manager, while all other upgrades
// (e.g. Next.js HMR) and plain HTTP requests are forwarded to Next.js as normal.

import "dotenv/config";
import { createServer } from "http";

import next from "next";
import { assertDockerAvailable, ensureContainer } from "./lib/infra/containerManager";
import { WebSocketServer } from "ws";
import { getWorkspace, resetWorkspaceMessages } from "./lib/infra/workspaceStore";
import {
  addConnection,
  removeConnection,
  getConnectionCount,
} from "./lib/infra/wsHub";
import { ensureWatcher, stopWatcher, markSelfWrite, stopAllWatchers } from "./lib/infra/workspaceWatcher";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);

const UI_USER = process.env.USERNAME ?? "";
const UI_PASS = process.env.PASSWORD ?? "";

function isAuthorized(req: import("http").IncomingMessage): boolean {
  if (!UI_USER || !UI_PASS) return true;
  const auth = req.headers["authorization"] ?? "";
  if (!auth.startsWith("Basic ")) return false;
  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  return decoded.slice(0, colon) === UI_USER && decoded.slice(colon + 1) === UI_PASS;
}

const httpServer = createServer();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app = next({ dev, httpServer, port, webpack: true } as any);
const handle = app.getRequestHandler();

httpServer.on("request", (req, res) => {
  const isApi = req.url?.startsWith("/api/");
  if (!isApi && !isAuthorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="App"' });
    res.end("Unauthorized");
    return;
  }
  handle(req, res);
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "", "http://localhost");
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

wss.on("connection", (ws, req) => {
  const workspaceId = new URL(req.url ?? "", "http://localhost").searchParams.get("workspaceId") ?? undefined;

  if (!workspaceId) {
    ws.close(1008, "workspaceId query param required");
    return;
  }

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    ws.close(1008, "workspace not found");
    return;
  }

  addConnection(workspaceId, ws);
  if (getConnectionCount(workspaceId) === 1) {
    ensureWatcher(workspaceId, workspace.dir);
    ensureContainer(workspaceId, workspace.dir).catch((err) =>
      console.error(`[container] failed to start for ${workspaceId}:`, err.message)
    );
  }

  const cleanup = () => {
    removeConnection(workspaceId, ws);
    setTimeout(() => {
      if (getConnectionCount(workspaceId) === 0) {
        stopWatcher(workspaceId);
        resetWorkspaceMessages(workspaceId);
      }
    }, 5000);
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { type: string; path?: string };
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
      if (msg.type === "self_write" && msg.path) {
        markSelfWrite(msg.path);
      }
    } catch {
      // ignore malformed messages
    }
  });
});

assertDockerAvailable().then(() => app.prepare()).then(() => {
  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});

function shutdown() {
  wss.close();
  stopAllWatchers();
  app.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
