import { ApiClient } from "@twurple/api";
import { ChatClient } from "@twurple/chat";
import { EventSubWsListener } from "@twurple/eventsub-ws";

import { loadConfig, type AppConfig } from "./config.js";
import { setLogLevel, makeLogger } from "./logger.js";
import { BotDatabase, type RedemptionRow } from "./db.js";
import { createAuthProvider, loadAllTokens, tokensToAccessToken } from "./twitch/auth.js";
import { RedemptionLogger } from "./features/redemptions.js";
import { MusicService } from "./features/music.js";
import { CommandRegistry } from "./commands/registry.js";
import { registerBuiltinCommands } from "./commands/builtin.js";
import { startWebServer, type WebServerHandle } from "./overlay/server.js";
import { createSetupRouter } from "./setup/router.js";

type RuntimeServices = {
  stop: () => Promise<void>;
};

async function main(): Promise<void> {
  const initialConfig = loadConfig();
  setLogLevel(initialConfig.logLevel);
  const log = makeLogger("main");

  log.info(`starting DearBot — ready=${initialConfig.ready}`);

  const web: WebServerHandle = await startWebServer({
    port: initialConfig.web.port,
    overlayToken: initialConfig.web.overlayToken,
    publicUrl: initialConfig.web.publicUrl,
  });

  let runtime: RuntimeServices | null = null;

  const reload = async (): Promise<void> => {
    log.info("config changed — reloading runtime services…");
    if (runtime) {
      try {
        await runtime.stop();
      } catch (err) {
        log.warn(`runtime stop error: ${(err as Error).message}`);
      }
      runtime = null;
      web.detachMusic();
    }
    const cfg = loadConfig();
    if (!cfg.ready) {
      log.info("not ready yet (missing Twitch credentials or channel) — waiting on the setup wizard.");
      return;
    }
    try {
      runtime = await startRuntime(cfg, web);
      log.info("runtime started.");
    } catch (err) {
      log.error(`runtime failed to start: ${(err as Error).stack ?? (err as Error).message}`);
    }
  };

  web.app.use(
    createSetupRouter({
      store: initialConfig.store,
      tokensFile: initialConfig.twitch.tokensFile,
      onConfigChange: reload,
    }),
  );

  // Try to start the runtime immediately if everything is configured.
  if (initialConfig.ready && Object.keys(loadAllTokens(initialConfig.twitch.tokensFile)).length > 0) {
    try {
      runtime = await startRuntime(initialConfig, web);
    } catch (err) {
      log.error(`initial runtime start failed: ${(err as Error).message}`);
      log.error("open the setup wizard to fix the configuration.");
    }
  } else {
    log.info(`open the setup wizard at: ${web.setupUrl}`);
  }

  const shutdown = async (): Promise<void> => {
    log.info("shutting down…");
    if (runtime) {
      try {
        await runtime.stop();
      } catch (err) {
        log.warn(`runtime stop error: ${(err as Error).message}`);
      }
    }
    try {
      await web.stop();
    } catch (err) {
      log.warn(`web stop error: ${(err as Error).message}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startRuntime(config: AppConfig, web: WebServerHandle): Promise<RuntimeServices> {
  const log = makeLogger("runtime");

  // ---------------- Auth ----------------
  const tokens = loadAllTokens(config.twitch.tokensFile);
  if (Object.keys(tokens).length === 0) {
    throw new Error("no tokens yet — finish the setup wizard first.");
  }

  const authProvider = createAuthProvider(
    config.twitch.clientId,
    config.twitch.clientSecret,
    config.twitch.tokensFile,
  );

  const api = new ApiClient({ authProvider });

  const broadcasterUser = await api.users.getUserByName(config.twitch.channel);
  if (!broadcasterUser) throw new Error(`Twitch user "${config.twitch.channel}" not found`);

  const botLogin = config.twitch.botLogin || config.twitch.channel;
  const botUser =
    botLogin === config.twitch.channel
      ? broadcasterUser
      : ((await api.users.getUserByName(botLogin)) ?? null);
  if (!botUser) throw new Error(`Twitch user "${botLogin}" not found`);

  if (!tokens[broadcasterUser.id]) {
    throw new Error(
      `no token for broadcaster "${config.twitch.channel}" (id ${broadcasterUser.id}). Re-authorize via the setup wizard.`,
    );
  }
  if (!tokens[botUser.id]) {
    throw new Error(
      `no token for bot "${botLogin}" (id ${botUser.id}). Re-authorize as that account in the wizard, or unset the bot login.`,
    );
  }

  for (const [storedUserId, t] of Object.entries(tokens)) {
    const intents: string[] = [];
    if (storedUserId === broadcasterUser.id) intents.push("broadcaster");
    if (storedUserId === botUser.id) intents.push("chat");
    authProvider.addUser(storedUserId, tokensToAccessToken(t), intents);
  }

  // ---------------- DB & feature services ----------------
  const db = new BotDatabase("./data/bot.db");

  const redemptions = new RedemptionLogger(db, {
    filterIds: config.rewards.loggedIds,
    discordWebhookUrl: config.discordWebhookUrl,
    googleSheetsWebhook: config.googleSheetsWebhook,
    csvPath: "./data/redemptions.csv",
  });

  const music = new MusicService({
    maxDurationSeconds: config.music.maxDurationSeconds,
    perUserLimit: config.music.perUserLimit,
  });

  web.attachMusic(music);

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
  chat.onConnect(() => log.info(`chat connected as ${botLogin} → #${config.twitch.channel}`));
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

    if (config.rewards.musicId && e.rewardId === config.rewards.musicId && e.input.trim()) {
      const result = await music.searchAndQueue(
        e.input.trim(),
        e.userName.toLowerCase(),
        e.userDisplayName,
      );
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

  return {
    stop: async () => {
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
        db.close();
      } catch (err) {
        log.warn(`db close error: ${(err as Error).message}`);
      }
      web.detachMusic();
    },
  };
}

main().catch((err: unknown) => {
  console.error("[fatal]", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
