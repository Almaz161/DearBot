import "dotenv/config";
import { z } from "zod";
import crypto from "node:crypto";

const Schema = z.object({
  TWITCH_CLIENT_ID: z.string().min(1, "TWITCH_CLIENT_ID is required"),
  TWITCH_CLIENT_SECRET: z.string().min(1, "TWITCH_CLIENT_SECRET is required"),
  TWITCH_CHANNEL: z.string().min(1, "TWITCH_CHANNEL is required"),
  TWITCH_BOT_LOGIN: z.string().optional().default(""),
  TWITCH_TOKENS_FILE: z.string().default("./data/tokens.json"),

  LOG_REWARD_IDS: z.string().default(""),
  MUSIC_REWARD_ID: z.string().default(""),

  MUSIC_MAX_DURATION: z.coerce.number().int().positive().default(600),
  MUSIC_PER_USER_LIMIT: z.coerce.number().int().positive().default(2),
  MUSIC_ALLOW_VIEWERS: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  OVERLAY_PORT: z.coerce.number().int().positive().default(4488),
  OVERLAY_TOKEN: z.string().default(""),

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
  overlay: {
    port: number;
    token: string;
  };
  discordWebhookUrl: string;
  googleSheetsWebhook: string;
  logLevel: "debug" | "info" | "warn" | "error";
};

export function loadConfig(): AppConfig {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}\n\nCheck your .env file (copy .env.example).`);
  }
  const env = parsed.data;
  const overlayToken = env.OVERLAY_TOKEN.trim() || crypto.randomBytes(16).toString("hex");
  return {
    twitch: {
      clientId: env.TWITCH_CLIENT_ID.trim(),
      clientSecret: env.TWITCH_CLIENT_SECRET.trim(),
      channel: env.TWITCH_CHANNEL.trim().toLowerCase(),
      botLogin: (env.TWITCH_BOT_LOGIN.trim() || env.TWITCH_CHANNEL.trim()).toLowerCase(),
      tokensFile: env.TWITCH_TOKENS_FILE,
    },
    rewards: {
      loggedIds: new Set(
        env.LOG_REWARD_IDS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
      musicId: env.MUSIC_REWARD_ID.trim(),
    },
    music: {
      maxDurationSeconds: env.MUSIC_MAX_DURATION,
      perUserLimit: env.MUSIC_PER_USER_LIMIT,
      allowViewers: env.MUSIC_ALLOW_VIEWERS,
    },
    overlay: {
      port: env.OVERLAY_PORT,
      token: overlayToken,
    },
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL.trim(),
    googleSheetsWebhook: env.GOOGLE_SHEETS_WEBHOOK.trim(),
    logLevel: env.LOG_LEVEL,
  };
}

export const REQUIRED_SCOPES = [
  "chat:read",
  "chat:edit",
  "channel:read:redemptions",
  "channel:manage:redemptions",
  "moderator:read:followers",
] as const;
