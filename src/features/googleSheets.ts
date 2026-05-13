import { makeLogger } from "../logger.js";
import type { RedemptionRow } from "../db.js";

const log = makeLogger("sheets");

/**
 * Posts each redemption to a Google Apps Script Web App deployment.
 * The Apps Script (see README) parses `e.postData.contents` and appends a row.
 *
 * Payload shape:
 * {
 *   "kind": "redemption",
 *   "redeemed_at": "2025-05-13T18:00:00.000Z",
 *   "reward_title": "Заказать песню",
 *   "user_login": "almaz161",
 *   "user_display": "Almaz161",
 *   "user_input": "Король и Шут — Лесник",
 *   "reward_id": "abc-123",
 *   "reward_cost": 500,
 *   "redemption_id": "xyz-456"
 * }
 */
export class GoogleSheetsSink {
  constructor(private readonly webhookUrl: string) {}

  async send(row: RedemptionRow): Promise<void> {
    const payload = {
      kind: "redemption",
      redeemed_at: row.redeemed_at,
      reward_title: row.reward_title,
      user_login: row.user_login,
      user_display: row.user_display,
      user_input: row.user_input,
      reward_id: row.reward_id,
      reward_cost: row.reward_cost,
      redemption_id: row.id,
    };

    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "follow",
      });
      if (!res.ok) {
        log.warn(`sheets webhook returned ${res.status} ${res.statusText}`);
        return;
      }
      log.debug(`sheets webhook ok for ${row.user_login}/${row.reward_title}`);
    } catch (err) {
      log.warn(`sheets webhook error: ${(err as Error).message}`);
    }
  }
}
