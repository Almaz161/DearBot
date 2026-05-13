import type { ChatClient, ChatMessage } from "@twurple/chat";

export type CommandContext = {
  channel: string;
  user: string;
  text: string;
  args: string[];
  msg: ChatMessage;
  reply: (text: string) => Promise<void>;
  isMod: boolean;
  isBroadcaster: boolean;
};

export type CommandHandler = (ctx: CommandContext) => Promise<void> | void;

export type Command = {
  name: string;
  aliases?: string[];
  modOnly?: boolean;
  description?: string;
  handler: CommandHandler;
};

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(cmd: Command): void {
    const all = [cmd.name, ...(cmd.aliases ?? [])].map((s) => s.toLowerCase());
    for (const n of all) this.commands.set(n, cmd);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name.toLowerCase());
  }

  list(): Command[] {
    const seen = new Set<Command>();
    for (const c of this.commands.values()) seen.add(c);
    return Array.from(seen);
  }

  async dispatch(client: ChatClient, channel: string, user: string, text: string, msg: ChatMessage): Promise<void> {
    if (!text.startsWith("!")) return;
    const trimmed = text.slice(1).trim();
    if (!trimmed) return;
    const [name, ...args] = trimmed.split(/\s+/);
    const cmd = this.get(name);
    if (!cmd) return;

    const isMod = msg.userInfo.isMod;
    const isBroadcaster = msg.userInfo.isBroadcaster;
    if (cmd.modOnly && !isMod && !isBroadcaster) return;

    const ctx: CommandContext = {
      channel,
      user,
      text: args.join(" "),
      args,
      msg,
      isMod,
      isBroadcaster,
      reply: async (replyText: string) => {
        await client.say(channel, replyText, { replyTo: msg.id });
      },
    };

    try {
      await cmd.handler(ctx);
    } catch (err) {
      console.error(`[commands] handler for !${cmd.name} threw:`, err);
      await ctx.reply("упс, что-то сломалось при выполнении команды").catch(() => undefined);
    }
  }
}
