import "dotenv/config";
import { z } from "zod";
import crypto from "node:crypto";
import { ConfigStore, type PersistedConfig } from "./configStore.js";

const Schema = z.object({
  TWITCH_CLIENT_ID: z.string().default(""),
  TWITCH_CLIENT_SECRET: z.string().default(""),
  TWITCH_CHANNEL: z.string().default(""),
  TWITCH_BOT_LOGIN: z.string().optional().default(""),
  TWITCH_TOKENS_FILE: z.string().default("./data/tokens.json"),
  CONFIG_FILE: z.string().default("./data/config.json"),

  LOG_REWARD_IDS: z.string().default(""),
  MUSIC_REWARD_ID: z.string().default(""),

  MUSIC_MAX_DURATION: z.coerce.number().int().positive().default(600),
  MUSIC_PER_USER_LIMIT: z.coerce.number().int().positive().default(2),
  MUSIC_ALLOW_VIEWERS: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  PORT: z.coerce.number().int().positive().optional(),
  OVERLAY_PORT: z.coerce.number().int().positive().default(4488),
  OVERLAY_TOKEN: z.string().default(""),
  PUBLIC_URL: z.string().default(""),

  DISCORD_WEBHOOK_URL: z.string().default(""),
  GOOGLE_SHEETS_WEBHOOK: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = {
  twitch: {
    clientId: string;
    clientSecret: string;
    channel: string;
    botLogin: string;
    tokensFile: string;
  };
  rewards: {
    loggedIds: Set<string>;
    musicId: string;
  };
  music: {
    maxDurationSeconds: number;
    perUserLimit: number;
    allowViewers: boolean;
  };
  web: {
    port: number;
    overlayToken: string;
    publicUrl: string;
  };
  discordWebhookUrl: string;
  googleSheetsWebhook: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * True once the streamer has finished the in-app setup wizard (Twitch app
   * credentials present + at least one authorized user). When false, the bot
   * runs in "setup mode": only the web server is started so the wizard at
   * /setup is reachable.
   */
  ready: boolean;
  store: ConfigStore;
};

function pick<T>(persisted: T | undefined, env: T | undefined, fallback: T): T {
  if (persisted !== undefined && persisted !== "") return persisted;
  if (env !== undefined && env !== "") return env;
  return fallback;
}

export function loadConfig(): AppConfig {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const store = new ConfigStore(env.CONFIG_FILE);
  const p: PersistedConfig = store.get();

  const clientId = pick(p.twitchClientId, env.TWITCH_CLIENT_ID, "");
  const clientSecret = pick(p.twitchClientSecret, env.TWITCH_CLIENT_SECRET, "");
  const channel = pick(p.twitchChannel, env.TWITCH_CHANNEL, "").toLowerCase();
  const botLogin = pick(p.twitchBotLogin, env.TWITCH_BOT_LOGIN, channel).toLowerCase();

  const loggedIdsCsv = env.LOG_REWARD_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  const loggedIds = new Set<string>([...(p.loggedRewardIds ?? []), ...loggedIdsCsv]);

  const musicId = pick(p.musicRewardId, env.MUSIC_REWARD_ID, "");

  // Generate and persist a stable overlay token on first run.
  let overlayToken = pick(p.overlayToken, env.OVERLAY_TOKEN, "");
  if (!overlayToken) {
    overlayToken = crypto.randomBytes(16).toString("hex");
    store.update({ overlayToken });
  }

  // Railway / Render / Fly set $PORT. Fall back to OVERLAY_PORT for local dev.
  const port = env.PORT ?? env.OVERLAY_PORT;

  // Public URL: persisted > env > derived. We do not auto-derive — when missing,
  // the wizard will offer to fill it from the current request's Host header.
  const publicUrl = pick(p.publicUrl, env.PUBLIC_URL, "");

  const musicMaxDuration = pick(p.musicMaxDuration, env.MUSIC_MAX_DURATION, env.MUSIC_MAX_DURATION);
  const musicPerUserLimit = pick(p.musicPerUserLimit, env.MUSIC_PER_USER_LIMIT, env.MUSIC_PER_USER_LIMIT);
  const musicAllowViewers = p.musicAllowViewers ?? env.MUSIC_ALLOW_VIEWERS;

  const discordWebhookUrl = pick(p.discordWebhookUrl, env.DISCORD_WEBHOOK_URL, "").trim();
  const googleSheetsWebhook = pick(p.googleSheetsWebhook, env.GOOGLE_SHEETS_WEBHOOK, "").trim();

  // Ready when we have everything we need to actually start the Twitch services.
  const ready = Boolean(clientId && clientSecret && channel);

  return {
    twitch: {
      clientId,
      clientSecret,
      channel,
      botLogin,
      tokensFile: env.TWITCH_TOKENS_FILE,
    },
    rewards: {
      loggedIds,
      musicId,
    },
    music: {
      maxDurationSeconds: musicMaxDuration,
      perUserLimit: musicPerUserLimit,
      allowViewers: musicAllowViewers,
    },
    web: {
      port,
      overlayToken,
      publicUrl: publicUrl.replace(/\/+$/, ""),
    },
    discordWebhookUrl,
    googleSheetsWebhook,
    logLevel: env.LOG_LEVEL,
    ready,
    store,
  };
}

export const REQUIRED_SCOPES = [
  "chat:read",
  "chat:edit",
  "channel:read:redemptions",
  "channel:manage:redemptions",
  "moderator:read:followers",
] as const;
