import { CommandRegistry, type Command } from "./registry.js";
import { type MusicService, formatDuration } from "../features/music.js";

export type BuiltinDeps = {
  music: MusicService;
  allowViewers: boolean;
};

export function registerBuiltinCommands(registry: CommandRegistry, deps: BuiltinDeps): void {
  const { music, allowViewers } = deps;

  const requestSong: Command = {
    name: "sr",
    aliases: ["songrequest", "song", "music"],
    description: "Заказать песню. Пример: !sr Король и Шут — Лесник",
    handler: async (ctx) => {
      if (!allowViewers && !ctx.isMod && !ctx.isBroadcaster) {
        await ctx.reply("заказ музыки доступен только модераторам");
        return;
      }
      const query = ctx.args.join(" ").trim();
      if (!query) {
        await ctx.reply("укажи название трека: !sr исполнитель — название");
        return;
      }
      const result = await music.searchAndQueue(query, ctx.user.toLowerCase(), ctx.msg.userInfo.displayName);
      if (!result.ok) {
        await ctx.reply(result.reason);
        return;
      }
      const state = music.getState();
      const position = state.queue.findIndex((t) => t.id === result.track.id);
      const positionText = position === -1 ? "сейчас играет" : `в очереди #${position + 1}`;
      await ctx.reply(
        `добавил ${positionText}: ${result.track.author} — ${result.track.title} (${formatDuration(result.track.durationSeconds)})`,
      );
    },
  };

  const queue: Command = {
    name: "queue",
    aliases: ["q", "songs"],
    description: "Показать очередь треков",
    handler: async (ctx) => {
      const state = music.getState();
      if (!state.current) {
        await ctx.reply("очередь пуста");
        return;
      }
      const lines = [
        `сейчас: ${state.current.author} — ${state.current.title} (от ${state.current.requestedByDisplay})`,
      ];
      const upcoming = state.queue.slice(0, 3);
      for (const [i, t] of upcoming.entries()) {
        lines.push(`#${i + 1} ${t.author} — ${t.title} (от ${t.requestedByDisplay})`);
      }
      if (state.queue.length > upcoming.length) {
        lines.push(`…и ещё ${state.queue.length - upcoming.length}`);
      }
      await ctx.reply(lines.join(" | "));
    },
  };

  const skip: Command = {
    name: "skip",
    aliases: ["next"],
    modOnly: true,
    description: "Пропустить текущий трек (только мод)",
    handler: async (ctx) => {
      const previous = music.skip();
      if (!previous) {
        await ctx.reply("сейчас ничего не играет");
      } else {
        await ctx.reply(`пропустил: ${previous.author} — ${previous.title}`);
      }
    },
  };

  const clearQueue: Command = {
    name: "clearqueue",
    aliases: ["clearq", "qclear"],
    modOnly: true,
    description: "Очистить очередь (только мод)",
    handler: async (ctx) => {
      music.clear();
      await ctx.reply("очередь очищена");
    },
  };

  const volume: Command = {
    name: "volume",
    aliases: ["vol"],
    modOnly: true,
    description: "Громкость 0-100 (только мод): !volume 60",
    handler: async (ctx) => {
      const raw = ctx.args[0];
      if (!raw) {
        await ctx.reply(`текущая громкость: ${music.getState().volume}`);
        return;
      }
      const v = parseInt(raw, 10);
      if (Number.isNaN(v)) {
        await ctx.reply("укажи число 0-100");
        return;
      }
      const newVolume = music.setVolume(v);
      await ctx.reply(`громкость: ${newVolume}`);
    },
  };

  const pause: Command = {
    name: "pause",
    modOnly: true,
    description: "Пауза (только мод)",
    handler: async (ctx) => {
      music.pause();
      await ctx.reply("⏸ пауза");
    },
  };

  const resume: Command = {
    name: "resume",
    aliases: ["play"],
    modOnly: true,
    description: "Продолжить (только мод)",
    handler: async (ctx) => {
      music.resume();
      await ctx.reply("▶ продолжаю");
    },
  };

  const help: Command = {
    name: "help",
    aliases: ["commands"],
    description: "Список команд",
    handler: async (ctx) => {
      const lines = registry
        .list()
        .filter((c) => !c.modOnly || ctx.isMod || ctx.isBroadcaster)
        .map((c) => `!${c.name}`)
        .join(" ");
      await ctx.reply(`команды: ${lines}`);
    },
  };

  for (const c of [requestSong, queue, skip, clearQueue, volume, pause, resume, help]) {
    registry.register(c);
  }
}
