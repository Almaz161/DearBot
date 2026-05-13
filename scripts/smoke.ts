/**
 * Smoke test that does not need any Twitch credentials.
 * Starts the overlay server with a synthetic MusicService, fetches the overlay page,
 * connects to the WebSocket, simulates a track ending, and verifies state transitions.
 */
import WebSocket from "ws";
import { MusicService } from "../src/features/music.js";
import { startOverlayServer } from "../src/overlay/server.js";
import { setLogLevel } from "../src/logger.js";

function fakeTrack(id: string, videoId: string, requestedBy: string) {
  return {
    id,
    videoId,
    title: `Test track ${id}`,
    author: "Test Author",
    durationSeconds: 180,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    requestedBy,
    requestedByDisplay: requestedBy,
    requestedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  setLogLevel("warn");

  // Subclass that exposes synthetic insertion paths so the smoke test does not
  // have to hit the live YouTube search API.
  class TestMusic extends MusicService {
    setTrack(t: ReturnType<typeof fakeTrack>): void {
      (this as unknown as { current: ReturnType<typeof fakeTrack> | null }).current = t;
      this.emit("change");
    }
    enqueue(t: ReturnType<typeof fakeTrack>): void {
      (this as unknown as { queue: ReturnType<typeof fakeTrack>[] }).queue.push(t);
      this.emit("change");
    }
  }
  const tm = new TestMusic({ maxDurationSeconds: 600, perUserLimit: 5 });
  const t1 = fakeTrack("1", "dQw4w9WgXcQ", "alice");
  const t2 = fakeTrack("2", "M7lc1UVf-VE", "bob");
  tm.setTrack(t1);
  tm.enqueue(t2);

  const overlay = await startOverlayServer({ port: 0, token: "smoke", music: tm });
  // Re-read port from URL (port=0 means OS-assigned).
  const parsed = new URL(overlay.url);
  const port = parsed.port;

  const failures: string[] = [];

  // HTTP fetch /overlay
  const overlayRes = await fetch(`http://localhost:${port}/overlay?token=smoke`);
  if (overlayRes.status !== 200) failures.push(`overlay status: ${overlayRes.status}`);
  const html = await overlayRes.text();
  if (!html.includes("YT.Player") && !html.includes("youtube")) {
    failures.push("overlay HTML missing YouTube iframe code");
  }

  // HTTP fetch /state
  const stateRes = await fetch(`http://localhost:${port}/state?token=smoke`);
  if (stateRes.status !== 200) failures.push(`state status: ${stateRes.status}`);
  const state = (await stateRes.json()) as { current: { videoId: string } | null; queue: unknown[] };
  if (state.current?.videoId !== "dQw4w9WgXcQ") failures.push("state.current wrong");
  if (state.queue.length !== 1) failures.push("state.queue length wrong");

  // Bad token rejected
  const bad = await fetch(`http://localhost:${port}/state?token=bad`);
  if (bad.status !== 401) failures.push(`bad token expected 401, got ${bad.status}`);

  // WebSocket
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=smoke`);
    let gotState = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("ws timeout"));
    }, 5000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; state?: { current: { videoId: string } | null } };
      if (msg.type === "state") {
        if (!gotState) {
          gotState = true;
          if (msg.state?.current?.videoId !== "dQw4w9WgXcQ") failures.push("ws initial state wrong");
          ws.send(JSON.stringify({ type: "track_ended" }));
        } else {
          // After track_ended, current should be t2.
          if (msg.state?.current?.videoId !== "M7lc1UVf-VE") failures.push("ws advance state wrong");
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Reject ws with bad token
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=bad`);
    ws.on("error", () => resolve());
    ws.on("open", () => {
      failures.push("bad token ws should not have opened");
      ws.close();
      resolve();
    });
  });

  await overlay.stop();

  if (failures.length) {
    console.error("smoke FAILED:");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log("smoke OK ✓");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[smoke] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
