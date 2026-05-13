/**
 * Mutable, on-disk config. Anything the streamer can change from the in-app /setup
 * wizard lives here. Values in this file override the corresponding .env values,
 * so once the wizard has run the bot can be operated without ever touching .env.
 */
import fs from "node:fs";
import path from "node:path";
import { makeLogger } from "./logger.js";

const log = makeLogger("configStore");

export type PersistedConfig = {
  // Twitch app credentials (entered in the setup wizard or via .env).
  twitchClientId?: string;
  twitchClientSecret?: string;
  // Broadcaster login (the channel the bot watches). After OAuth, this is filled
  // in automatically from the authorized user.
  twitchChannel?: string;
  // Optional separate bot account login. If unset, the broadcaster's tokens are
  // used to chat as well.
  twitchBotLogin?: string;

  // Reward configuration.
  loggedRewardIds?: string[];
  musicRewardId?: string;

  // Music tuning (defaults applied at load if missing).
  musicMaxDuration?: number;
  musicPerUserLimit?: number;
  musicAllowViewers?: boolean;

  // Integrations.
  discordWebhookUrl?: string;
  googleSheetsWebhook?: string;

  // The base URL the bot is reachable at (e.g. `https://my-bot.up.railway.app`).
  // Used to build the OAuth redirect URI and the OBS overlay URL.
  publicUrl?: string;

  // Auto-generated on first run; persisted so the OBS URL stays stable across restarts.
  overlayToken?: string;
};

export class ConfigStore {
  private cache: PersistedConfig;

  constructor(private readonly filePath: string) {
    this.cache = this.read();
  }

  private read(): PersistedConfig {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8").trim();
      if (!raw) return {};
      return JSON.parse(raw) as PersistedConfig;
    } catch (err) {
      log.warn(`failed to parse ${this.filePath}: ${(err as Error).message}; treating as empty`);
      return {};
    }
  }

  get(): PersistedConfig {
    return { ...this.cache };
  }

  update(patch: Partial<PersistedConfig>): PersistedConfig {
    this.cache = { ...this.cache, ...patch };
    this.persist();
    return this.get();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2));
  }
}
