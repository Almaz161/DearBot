import express, { type Express } from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { MusicService, MusicState } from "../features/music.js";
import { makeLogger } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = makeLogger("overlay");

type ClientMessage = { type: "track_ended" } | { type: "request_state" };

type ServerMessage =
  | { type: "state"; state: MusicState }
  | { type: "command"; action: "play" | "pause" | "skip" | "set_volume"; volume?: number };

export type WebServerHandle = {
  app: Express;
  overlayUrl: string;
  setupUrl: string;
  stop: () => Promise<void>;
  /** Attach music WS overlay once music service is available (called after setup completes). */
  attachMusic: (music: MusicService) => void;
  detachMusic: () => void;
};

export function startWebServer(opts: {
  port: number;
  overlayToken: string;
  publicUrl: string;
}): Promise<WebServerHandle> {
  const { port, overlayToken, publicUrl } = opts;
  const app = express();

  // Trust the first proxy hop (Railway, Render, Fly all front Express). Without
  // this, `req.protocol` and `x-forwarded-*` headers are ignored.
  app.set("trust proxy", 1);

  const publicDir = path.resolve(__dirname, "./public");
  app.use("/static", express.static(publicDir));

  app.get("/", (_req, res) => {
    res.redirect("/setup");
  });

  app.get("/overlay", (req, res) => {
    if (req.query.token !== overlayToken) {
      res.status(401).send("Invalid token");
      return;
    }
    res.sendFile(path.join(publicDir, "index.html"));
  });

  let attachedMusic: MusicService | null = null;

  app.get("/state", (req, res) => {
    if (req.query.token !== overlayToken) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    if (!attachedMusic) {
      res.json({ status: "setup-mode", queue: [], current: null });
      return;
    }
    res.json(attachedMusic.getState());
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, ready: attachedMusic !== null });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    if (url.pathname !== "/ws" || url.searchParams.get("token") !== overlayToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const broadcast = (msg: ServerMessage): void => {
    const payload = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  let onStateChange: (() => void) | null = null;

  const attachMusic = (music: MusicService): void => {
    attachedMusic = music;
    onStateChange = (): void => broadcast({ type: "state", state: music.getState() });
    music.on("change", onStateChange);
  };
  const detachMusic = (): void => {
    if (attachedMusic && onStateChange) {
      attachedMusic.off("change", onStateChange);
    }
    attachedMusic = null;
    onStateChange = null;
  };

  wss.on("connection", (ws) => {
    log.info(`overlay connected (${wss.clients.size} total)`);
    if (attachedMusic) {
      ws.send(JSON.stringify({ type: "state", state: attachedMusic.getState() }));
    }
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (!attachedMusic) return;
      if (msg.type === "track_ended") {
        attachedMusic.advance();
      } else if (msg.type === "request_state") {
        ws.send(JSON.stringify({ type: "state", state: attachedMusic.getState() }));
      }
    });
    ws.on("close", () => log.info(`overlay disconnected (${wss.clients.size} remaining)`));
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      const base = publicUrl || `http://localhost:${actualPort}`;
      const overlayUrl = `${base}/overlay?token=${encodeURIComponent(overlayToken)}`;
      const setupUrl = `${base}/setup`;
      log.info(`web server listening on http://localhost:${actualPort}`);
      log.info(`Setup wizard: ${setupUrl}`);
      log.info(`OBS Browser Source URL: ${overlayUrl}`);
      resolve({
        app,
        overlayUrl,
        setupUrl,
        attachMusic,
        detachMusic,
        stop: async () => {
          detachMusic();
          await new Promise<void>((r) => wss.close(() => r()));
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
