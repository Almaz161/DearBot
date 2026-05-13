import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export type RedemptionRow = {
  id: string;
  reward_id: string;
  reward_title: string;
  reward_cost: number;
  user_id: string;
  user_login: string;
  user_display: string;
  user_input: string;
  redeemed_at: string;
};

export class BotDatabase {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS redemptions (
        id TEXT PRIMARY KEY,
        reward_id TEXT NOT NULL,
        reward_title TEXT NOT NULL,
        reward_cost INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        user_login TEXT NOT NULL,
        user_display TEXT NOT NULL,
        user_input TEXT NOT NULL,
        redeemed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_redemptions_reward ON redemptions(reward_id);
      CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(user_login);
      CREATE INDEX IF NOT EXISTS idx_redemptions_time ON redemptions(redeemed_at);
    `);
  }

  insertRedemption(row: RedemptionRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO redemptions
         (id, reward_id, reward_title, reward_cost, user_id, user_login, user_display, user_input, redeemed_at)
         VALUES (@id, @reward_id, @reward_title, @reward_cost, @user_id, @user_login, @user_display, @user_input, @redeemed_at)`,
      )
      .run(row);
  }

  listRecentRedemptions(limit = 50): RedemptionRow[] {
    return this.db
      .prepare(`SELECT * FROM redemptions ORDER BY redeemed_at DESC LIMIT ?`)
      .all(limit) as RedemptionRow[];
  }

  close(): void {
    this.db.close();
  }
}
