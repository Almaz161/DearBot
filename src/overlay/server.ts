import express from "express";
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

export type OverlayServerHandle = {
  url: string;
  stop: () => Promise<void>;
};

export function startOverlayServer(opts: {
  port: number;
  token: string;
  music: MusicService;
}): Promise<OverlayServerHandle> {
  const { port, token, music } = opts;
  const app = express();

  // Serve overlay static page. In dev (tsx), __dirname=src/overlay; in prod (tsc build),
  // __dirname=dist/src/overlay and we copy public/ alongside it via the `build` script.
  const publicDir = path.resolve(__dirname, "./public");
  app.use("/static", express.static(publicDir));

  app.get("/", (_req, res) => {
    res.redirect(`/overlay?token=${encodeURIComponent(token)}`);
  });

  app.get("/overlay", (req, res) => {
    if (req.query.token !== token) {
      res.status(401).send("Invalid token");
      return;
    }
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/state", (req, res) => {
    if (req.query.token !== token) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    res.json(music.getState());
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    if (url.pathname !== "/ws" || url.searchParams.get("token") !== token) {
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

  const onStateChange = (): void => broadcast({ type: "state", state: music.getState() });
  music.on("change", onStateChange);

  wss.on("connection", (ws) => {
    log.info(`overlay connected (${wss.clients.size} total)`);
    ws.send(JSON.stringify({ type: "state", state: music.getState() }));

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "track_ended") {
        music.advance();
      } else if (msg.type === "request_state") {
        ws.send(JSON.stringify({ type: "state", state: music.getState() }));
      }
    });

    ws.on("close", () => {
      log.info(`overlay disconnected (${wss.clients.size} remaining)`);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      const overlayUrl = `http://localhost:${actualPort}/overlay?token=${encodeURIComponent(token)}`;
      log.info(`overlay HTTP listening on http://localhost:${actualPort}`);
      log.info(`OBS Browser Source URL: ${overlayUrl}`);
      resolve({
        url: overlayUrl,
        stop: async () => {
          music.off("change", onStateChange);
          await new Promise<void>((r) => wss.close(() => r()));
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
