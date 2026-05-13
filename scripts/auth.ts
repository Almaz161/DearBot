/**
 * One-time OAuth helper.
 *
 * Run with `npm run auth`. Steps:
 *   1. Reads TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET from .env
 *   2. Starts a local HTTP server on http://localhost:4489/callback (the redirect URI you
 *      registered for your Twitch app)
 *   3. Prints an authorization URL — open it in your browser, log in as the account whose
 *      token you want to store (your broadcaster account, and again for the bot account if
 *      different)
 *   4. Captures the authorization code on the callback, exchanges it for tokens, fetches
 *      the user ID, and writes the result to data/tokens.json keyed by userId
 */
import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import { exchangeCode, getTokenInfo } from "@twurple/auth";
import { saveTokens, loadAllTokens, type StoredTokens } from "../src/twitch/auth.js";

const CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? "";
const TOKENS_FILE = process.env.TWITCH_TOKENS_FILE ?? "./data/tokens.json";
const REDIRECT_URI = "http://localhost:4489/callback";

const SCOPES = [
  "chat:read",
  "chat:edit",
  "channel:read:redemptions",
  "channel:manage:redemptions",
  "moderator:read:followers",
];

function fail(msg: string): never {
  console.error(`\n[auth] ${msg}\n`);
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  fail(
    "TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set in .env first.\n" +
      "Create an app at https://dev.twitch.tv/console/apps and add the redirect URI\n" +
      "  http://localhost:4489/callback\n" +
      "then paste the values into .env.",
  );
}

const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("force_verify", "true");

console.log("\nOpen this URL in a browser and authorize the app:\n");
console.log(`  ${authUrl.toString()}\n`);
console.log(
  "Tip: log into the account whose token you want (broadcaster first; re-run for a separate bot account if needed).\n",
);

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end("missing url");
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    res.statusCode = 400;
    res.end(`Twitch returned an error: ${error}`);
    console.error(`[auth] ${error} — ${url.searchParams.get("error_description") ?? ""}`);
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.statusCode = 400;
    res.end("missing code");
    return;
  }

  try {
    const token = await exchangeCode(CLIENT_ID, CLIENT_SECRET, code, REDIRECT_URI);
    const info = await getTokenInfo(token.accessToken, CLIENT_ID);
    if (!info.userId || !info.userName) {
      throw new Error("token has no user");
    }

    const stored: StoredTokens = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? "",
      scope: token.scope ?? [],
      expiresIn: token.expiresIn ?? 0,
      obtainmentTimestamp: token.obtainmentTimestamp,
      userId: info.userId,
    };
    saveTokens(TOKENS_FILE, info.userId, stored);

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><meta charset=utf-8><title>OK</title>` +
        `<body style="font-family:system-ui;padding:40px;background:#0e0e10;color:#fff">` +
        `<h2 style="color:#9146ff">Token saved ✓</h2>` +
        `<p>User: <b>${escapeHtml(info.userName)}</b> (id <code>${escapeHtml(info.userId)}</code>)</p>` +
        `<p>Scopes: <code>${escapeHtml(info.scopes.join(" "))}</code></p>` +
        `<p>You can close this tab. Re-run <code>npm run auth</code> if you need a token for a different account.</p>` +
        `</body>`,
    );

    console.log(`\n[auth] saved token for ${info.userName} (userId=${info.userId})`);
    const all = loadAllTokens(TOKENS_FILE);
    console.log(`[auth] tokens.json now contains ${Object.keys(all).length} user(s).\n`);
    setTimeout(() => server.close(), 250);
  } catch (err) {
    res.statusCode = 500;
    res.end(`error: ${(err as Error).message}`);
    console.error("[auth]", err);
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

server.listen(4489, () => {
  console.log("[auth] listening on http://localhost:4489 — waiting for callback…\n");
});

server.on("close", () => {
  process.exit(0);
});
