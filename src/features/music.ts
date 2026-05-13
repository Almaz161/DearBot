import ytSearch, { type VideoLookup, type VideoSearchResult } from "yt-search";
import { EventEmitter } from "node:events";
import { makeLogger } from "../logger.js";

const log = makeLogger("music");

export type QueuedTrack = {
  id: string;
  videoId: string;
  title: string;
  author: string;
  durationSeconds: number;
  url: string;
  thumbnail: string;
  requestedBy: string;
  requestedByDisplay: string;
  requestedAt: string;
};

export type MusicState = {
  current: QueuedTrack | null;
  queue: QueuedTrack[];
  volume: number;
  paused: boolean;
};

export type SearchResult = { ok: true; track: QueuedTrack } | { ok: false; reason: string };

export type MusicOptions = {
  maxDurationSeconds: number;
  perUserLimit: number;
};

type YtCandidate = VideoSearchResult | VideoLookup;

function extractDurationSeconds(v: YtCandidate): number | null {
  if (typeof v.seconds === "number" && v.seconds > 0) return v.seconds;
  const d = v.duration;
  if (typeof d === "number") return d;
  if (d && typeof d === "object" && typeof d.seconds === "number") return d.seconds;
  const timestamp =
    typeof d === "string" ? d : typeof v.timestamp === "string" ? v.timestamp : undefined;
  if (timestamp) {
    const parts = timestamp.split(":").map((x) => parseInt(x, 10));
    if (parts.some(Number.isNaN)) return null;
    let total = 0;
    for (const p of parts) total = total * 60 + p;
    return total;
  }
  return null;
}

function extractAuthor(v: YtCandidate): string {
  if (!v.author) return "Unknown";
  if (typeof v.author === "string") return v.author;
  return v.author.name ?? "Unknown";
}

export class MusicService extends EventEmitter {
  private current: QueuedTrack | null = null;
  private queue: QueuedTrack[] = [];
  private volume = 50;
  private paused = false;
  private nextId = 1;

  constructor(private readonly opts: MusicOptions) {
    super();
  }

  getState(): MusicState {
    return { current: this.current, queue: [...this.queue], volume: this.volume, paused: this.paused };
  }

  countForUser(userLogin: string): number {
    let n = 0;
    if (this.current?.requestedBy === userLogin) n++;
    for (const t of this.queue) if (t.requestedBy === userLogin) n++;
    return n;
  }

  async searchAndQueue(query: string, requestedBy: string, requestedByDisplay: string): Promise<SearchResult> {
    if (!query.trim()) return { ok: false, reason: "пустой запрос" };

    if (this.countForUser(requestedBy) >= this.opts.perUserLimit) {
      return {
        ok: false,
        reason: `у тебя уже ${this.opts.perUserLimit} трека в очереди — дождись своей очереди`,
      };
    }

    const trimmed = query.trim();
    const urlMatch = trimmed.match(/(?:youtu\.be\/|v=)([\w-]{11})/);

    let candidate: YtCandidate | null = null;
    try {
      if (urlMatch) {
        const lookup = await ytSearch({ videoId: urlMatch[1] });
        candidate = lookup ?? null;
      } else {
        const results = await ytSearch(trimmed);
        candidate = results.videos[0] ?? null;
      }
    } catch (err) {
      log.warn(`yt-search failed: ${(err as Error).message}`);
      return { ok: false, reason: "поиск временно недоступен" };
    }

    if (!candidate) {
      return { ok: false, reason: "ничего не нашёл" };
    }

    const durationSeconds = extractDurationSeconds(candidate);
    if (durationSeconds === null) {
      return { ok: false, reason: "не удалось определить длительность" };
    }
    if (durationSeconds > this.opts.maxDurationSeconds) {
      return {
        ok: false,
        reason: `слишком длинный трек (${formatDuration(durationSeconds)}, максимум ${formatDuration(this.opts.maxDurationSeconds)})`,
      };
    }

    const track: QueuedTrack = {
      id: String(this.nextId++),
      videoId: candidate.videoId,
      title: candidate.title,
      author: extractAuthor(candidate),
      durationSeconds,
      url: `https://www.youtube.com/watch?v=${candidate.videoId}`,
      thumbnail: candidate.thumbnail ?? `https://i.ytimg.com/vi/${candidate.videoId}/hqdefault.jpg`,
      requestedBy,
      requestedByDisplay,
      requestedAt: new Date().toISOString(),
    };

    if (this.current === null) {
      this.current = track;
      this.emit("change");
      log.info(`now playing: ${track.title} (req by ${requestedByDisplay})`);
    } else {
      this.queue.push(track);
      this.emit("change");
      log.info(`queued: ${track.title} at #${this.queue.length} (req by ${requestedByDisplay})`);
    }

    return { ok: true, track };
  }

  skip(): QueuedTrack | null {
    const previous = this.current;
    this.advance();
    return previous;
  }

  advance(): void {
    this.current = this.queue.shift() ?? null;
    this.paused = false;
    this.emit("change");
    if (this.current) log.info(`now playing: ${this.current.title}`);
    else log.info("queue empty");
  }

  clear(): void {
    this.queue = [];
    this.emit("change");
  }

  setVolume(v: number): number {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    this.emit("change");
    return this.volume;
  }

  pause(): void {
    if (this.current && !this.paused) {
      this.paused = true;
      this.emit("change");
    }
  }

  resume(): void {
    if (this.current && this.paused) {
      this.paused = false;
      this.emit("change");
    }
  }

  removeAt(index: number): QueuedTrack | null {
    if (index < 0 || index >= this.queue.length) return null;
    const [removed] = this.queue.splice(index, 1);
    this.emit("change");
    return removed ?? null;
  }
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
