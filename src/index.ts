import { ApiClient } from "@twurple/api";
import { ChatClient } from "@twurple/chat";
import { EventSubWsListener } from "@twurple/eventsub-ws";

import { loadConfig } from "./config.js";
import { setLogLevel, makeLogger } from "./logger.js";
import { BotDatabase, type RedemptionRow } from "./db.js";
import { createAuthProvider, loadAllTokens, tokensToAccessToken } from "./twitch/auth.js";
import { RedemptionLogger } from "./features/redemptions.js";
import { MusicService } from "./features/music.js";
import { CommandRegistry } from "./commands/registry.js";
import { registerBuiltinCommands } from "./commands/builtin.js";
import { startOverlayServer } from "./overlay/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const log = makeLogger("main");

  log.info("starting twitch bot…");

  // ---------------- Auth ----------------
  const tokens = loadAllTokens(config.twitch.tokensFile);
  if (Object.keys(tokens).length === 0) {
    log.error("no tokens found. Run `npm run auth` first to authorize the bot.");
    process.exit(1);
  }

  const authProvider = createAuthProvider(
    config.twitch.clientId,
    config.twitch.clientSecret,
    config.twitch.tokensFile,
  );

  const api = new ApiClient({ authProvider });

  // Resolve channel & bot logins → user IDs, then register tokens by userId.
  const broadcasterUser = await api.users.getUserByName(config.twitch.channel);
  if (!broadcasterUser) {
    throw new Error(`Twitch user "${config.twitch.channel}" not found`);
  }
  const botLogin = config.twitch.botLogin || config.twitch.channel;
  const botUser =
    botLogin === config.twitch.channel
      ? broadcasterUser
      : (await api.users.getUserByName(botLogin)) ?? null;
  if (!botUser) {
    throw new Error(`Twitch user "${botLogin}" not found`);
  }

  for (const [storedUserId, t] of Object.entries(tokens)) {
    const intents: string[] = [];
    if (storedUserId === broadcasterUser.id) intents.push("broadcaster");
    if (storedUserId === botUser.id) intents.push("chat");
    authProvider.addUser(storedUserId, tokensToAccessToken(t), intents);
  }

  if (!tokens[broadcasterUser.id]) {
    log.error(
      `no token for broadcaster "${config.twitch.channel}" (id ${broadcasterUser.id}). Re-run \`npm run auth\` while logged in as that user.`,
    );
    process.exit(1);
  }
  if (!tokens[botUser.id]) {
    log.error(
      `no token for bot "${botLogin}" (id ${botUser.id}). Re-run \`npm run auth\` while logged in as that user.`,
    );
    process.exit(1);
  }

  // ---------------- DB & feature services ----------------
  const db = new BotDatabase("./data/bot.db");

  const redemptions = new RedemptionLogger(
    db,
    config.rewards.loggedIds,
    config.discordWebhookUrl,
    "./data/redemptions.csv",
  );

  const music = new MusicService({
    maxDurationSeconds: config.music.maxDurationSeconds,
    perUserLimit: config.music.perUserLimit,
  });

  // ---------------- Overlay HTTP/WS server ----------------
  const overlay = await startOverlayServer({
    port: config.overlay.port,
    token: config.overlay.token,
    music,
  });
  log.info(`overlay URL (add as OBS Browser Source): ${overlay.url}`);

  // ---------------- Chat ----------------
  const chat = new ChatClient({
    authProvider,
    channels: [config.twitch.channel],
    authIntents: ["chat"],
  });

  const registry = new CommandRegistry();
  registerBuiltinCommands(registry, { music, allowViewers: config.music.allowViewers });

  chat.onMessage(async (channel, user, text, msg) => {
    await registry.dispatch(chat, channel, user, text, msg);
  });

  chat.onConnect(() => {
    log.info(`chat connected as ${botLogin} → #${config.twitch.channel}`);
  });
  chat.onDisconnect((manual, reason) => {
    if (manual) log.info("chat disconnected (manual)");
    else log.warn(`chat disconnected: ${reason?.message ?? "unknown reason"}`);
  });

  await chat.connect();

  // ---------------- EventSub ----------------
  const eventsub = new EventSubWsListener({ apiClient: api });

  eventsub.onUserSocketConnect((userId) => log.info(`eventsub connected for user ${userId}`));
  eventsub.onUserSocketDisconnect((userId, err) =>
    log.warn(`eventsub disconnected for user ${userId}: ${err?.message ?? "clean"}`),
  );

  const handleRedemption = async (e: {
    id: string;
    rewardId: string;
    rewardTitle: string;
    rewardCost: number;
    userId: string;
    userName: string;
    userDisplayName: string;
    input: string;
    redemptionDate: Date;
  }): Promise<void> => {
    const row: RedemptionRow = {
      id: e.id,
      reward_id: e.rewardId,
      reward_title: e.rewardTitle,
      reward_cost: e.rewardCost,
      user_id: e.userId,
      user_login: e.userName,
      user_display: e.userDisplayName,
      user_input: e.input,
      redeemed_at: e.redemptionDate.toISOString(),
    };

    await redemptions.record(row);

    // If this reward is the music-request reward, treat input as a song query.
    if (config.rewards.musicId && e.rewardId === config.rewards.musicId && e.input.trim()) {
      const result = await music.searchAndQueue(e.input.trim(), e.userName.toLowerCase(), e.userDisplayName);
      try {
        if (result.ok) {
          await chat.say(
            config.twitch.channel,
            `@${e.userDisplayName} добавил трек: ${result.track.author} — ${result.track.title}`,
          );
        } else {
          await chat.say(
            config.twitch.channel,
            `@${e.userDisplayName} не получилось добавить трек: ${result.reason}`,
          );
        }
      } catch (err) {
        log.warn(`could not announce music redemption: ${(err as Error).message}`);
      }
    }
  };

  eventsub.onChannelRedemptionAdd(broadcasterUser.id, handleRedemption);

  eventsub.start();
  log.info("eventsub started, subscribed to channel.channel_points_custom_reward_redemption.add");

  // ---------------- Shutdown ----------------
  const shutdown = async (): Promise<void> => {
    log.info("shutting down…");
    try {
      eventsub.stop();
    } catch (err) {
      log.warn(`eventsub stop error: ${(err as Error).message}`);
    }
    try {
      chat.quit();
    } catch (err) {
      log.warn(`chat quit error: ${(err as Error).message}`);
    }
    try {
      await overlay.stop();
    } catch (err) {
      log.warn(`overlay stop error: ${(err as Error).message}`);
    }
    try {
      db.close();
    } catch (err) {
      log.warn(`db close error: ${(err as Error).message}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error("[fatal]", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
