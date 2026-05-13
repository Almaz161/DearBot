import fs from "node:fs";
import path from "node:path";
import { BotDatabase, type RedemptionRow } from "../db.js";
import { makeLogger } from "../logger.js";

const log = makeLogger("redemptions");

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export class RedemptionLogger {
  private readonly csvPath: string;

  constructor(
    private readonly db: BotDatabase,
    private readonly filterIds: Set<string>,
    private readonly discordWebhookUrl: string,
    csvPath = "./data/redemptions.csv",
  ) {
    this.csvPath = csvPath;
    this.ensureCsvHeader();
  }

  private ensureCsvHeader(): void {
    fs.mkdirSync(path.dirname(this.csvPath), { recursive: true });
    if (!fs.existsSync(this.csvPath) || fs.statSync(this.csvPath).size === 0) {
      const header = "redeemed_at,user_login,user_display,reward_title,reward_cost,user_input,reward_id,redemption_id\n";
      fs.writeFileSync(this.csvPath, header, { encoding: "utf-8" });
    }
  }

  shouldLog(rewardId: string): boolean {
    if (this.filterIds.size === 0) return true;
    return this.filterIds.has(rewardId);
  }

  async record(row: RedemptionRow): Promise<void> {
    if (!this.shouldLog(row.reward_id)) {
      log.debug(`skipping redemption for unwatched reward ${row.reward_id}`);
      return;
    }

    this.db.insertRedemption(row);
    this.appendCsv(row);
    log.info(
      `[reward] ${row.user_display} (${row.user_login}) redeemed "${row.reward_title}" (${row.reward_cost}): ${row.user_input || "<no input>"}`,
    );

    if (this.discordWebhookUrl) {
      await this.notifyDiscord(row);
    }
  }

  private appendCsv(row: RedemptionRow): void {
    const line =
      [
        row.redeemed_at,
        row.user_login,
        row.user_display,
        row.reward_title,
        String(row.reward_cost),
        row.user_input,
        row.reward_id,
        row.id,
      ]
        .map(csvEscape)
        .join(",") + "\n";
    fs.appendFileSync(this.csvPath, line, { encoding: "utf-8" });
  }

  private async notifyDiscord(row: RedemptionRow): Promise<void> {
    try {
      const body = {
        username: "Twitch Rewards",
        embeds: [
          {
            title: `${row.reward_title} (${row.reward_cost})`,
            description: row.user_input || "*no input*",
            fields: [
              { name: "User", value: `${row.user_display} (\`${row.user_login}\`)`, inline: true },
              { name: "When", value: row.redeemed_at, inline: true },
            ],
            color: 0x9146ff,
          },
        ],
      };
      const res = await fetch(this.discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        log.warn(`discord webhook failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      log.warn(`discord webhook error: ${(err as Error).message}`);
    }
  }
}
