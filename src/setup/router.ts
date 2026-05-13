import express, { type Router, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { ApiClient } from "@twurple/api";
import { StaticAuthProvider } from "@twurple/auth";
import { ConfigStore } from "../configStore.js";
import { saveTokens, loadAllTokens, type StoredTokens } from "../twitch/auth.js";
import { REQUIRED_SCOPES } from "../config.js";
import { makeLogger } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = makeLogger("setup");

type WizardState = {
  hasClientCreds: boolean;
  hasTokens: boolean;
  ready: boolean;
  channelLogin: string;
  botLogin: string;
  publicUrl: string;
  redirectUri: string;
  overlayUrl: string;
  rewardCount: number;
  loggedRewardIds: string[];
  musicRewardId: string;
  googleSheetsWebhook: string;
  authorizedUsers: { userId: string; userLogin: string; userDisplay: string; scopes: string[] }[];
};

type SetupContext = {
  store: ConfigStore;
  tokensFile: string;
  /** Called when the wizard saves enough config to start (or restart) the full bot. */
  onConfigChange: () => Promise<void> | void;
};

export function createSetupRouter(ctx: SetupContext): Router {
  const router = express.Router();
  const publicDir = path.resolve(__dirname, "./public");

  router.use("/setup/static", express.static(publicDir));

  router.get("/setup", (_req, res) => {
    res.sendFile(path.join(publicDir, "setup.html"));
  });

  router.get("/setup/api/state", (req, res) => {
    res.json(buildState(ctx, req));
  });

  router.post("/setup/api/twitch-app", express.json(), (req, res) => {
    const body = req.body as { clientId?: string; clientSecret?: string; botLogin?: string; publicUrl?: string };
    const clientId = String(body.clientId ?? "").trim();
    const clientSecret = String(body.clientSecret ?? "").trim();
    const botLogin = String(body.botLogin ?? "").trim().toLowerCase();
    const publicUrl = sanitizePublicUrl(body.publicUrl ?? "");

    if (!clientId || !clientSecret) {
      res.status(400).json({ error: "clientId and clientSecret are required" });
      return;
    }
    ctx.store.update({
      twitchClientId: clientId,
      twitchClientSecret: clientSecret,
      twitchBotLogin: botLogin || undefined,
      publicUrl: publicUrl || ctx.store.get().publicUrl,
    });
    res.json({ ok: true });
  });

  router.get("/setup/oauth/start", (req, res) => {
    const cfg = ctx.store.get();
    if (!cfg.twitchClientId) {
      res.status(400).send("Twitch Client ID not configured. Go back to step 1.");
      return;
    }
    const publicUrl = effectivePublicUrl(cfg.publicUrl, req);
    const redirectUri = `${publicUrl}/setup/oauth/callback`;
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie("oauth_state", state, { httpOnly: true, sameSite: "lax", maxAge: 10 * 60 * 1000 });

    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.searchParams.set("client_id", cfg.twitchClientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("force_verify", "true");
    res.redirect(url.toString());
  });

  router.get("/setup/oauth/callback", async (req, res) => {
    const cfg = ctx.store.get();
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const cookieState = parseCookies(req.headers.cookie ?? "")["oauth_state"];
    const errorParam = String(req.query.error ?? "");

    if (errorParam) {
      respondCallback(res, false, `Twitch denied authorization: ${errorParam}`);
      return;
    }
    if (!code || !state || !cookieState || state !== cookieState) {
      respondCallback(res, false, "Invalid or expired OAuth state — please retry the login.");
      return;
    }
    if (!cfg.twitchClientId || !cfg.twitchClientSecret) {
      respondCallback(res, false, "Twitch Client ID/Secret missing — go back to step 1.");
      return;
    }

    const publicUrl = effectivePublicUrl(cfg.publicUrl, req);
    const redirectUri = `${publicUrl}/setup/oauth/callback`;

    try {
      const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.twitchClientId,
          client_secret: cfg.twitchClientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }).toString(),
      });
      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        respondCallback(res, false, `Twitch /token returned ${tokenRes.status}: ${escapeHtml(body)}`);
        return;
      }
      const t = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope: string[];
      };

      // Identify the user.
      const userRes = await fetch("https://api.twitch.tv/helix/users", {
        headers: { authorization: `Bearer ${t.access_token}`, "client-id": cfg.twitchClientId },
      });
      if (!userRes.ok) {
        const body = await userRes.text();
        respondCallback(res, false, `Twitch /users returned ${userRes.status}: ${escapeHtml(body)}`);
        return;
      }
      const userBody = (await userRes.json()) as { data?: { id: string; login: string; display_name: string }[] };
      const user = userBody.data?.[0];
      if (!user) {
        respondCallback(res, false, "Twitch did not return a user record.");
        return;
      }

      const stored: StoredTokens = {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        scope: t.scope,
        expiresIn: t.expires_in,
        obtainmentTimestamp: Date.now(),
        userId: user.id,
      };
      saveTokens(ctx.tokensFile, user.id, stored);

      // First authorized user becomes the broadcaster by default.
      const current = ctx.store.get();
      const patch: Parameters<ConfigStore["update"]>[0] = {
        publicUrl: cfg.publicUrl || publicUrl,
      };
      if (!current.twitchChannel) {
        patch.twitchChannel = user.login;
      }
      ctx.store.update(patch);

      log.info(`authorized ${user.login} (id ${user.id}) — scopes: ${t.scope.join(",")}`);
      res.clearCookie("oauth_state");

      respondCallback(res, true, `Authorized <strong>${escapeHtml(user.display_name)}</strong>. Closing window…`);
    } catch (err) {
      respondCallback(res, false, `OAuth exchange failed: ${escapeHtml((err as Error).message)}`);
    }
  });

  router.get("/setup/api/rewards", async (req, res) => {
    const cfg = ctx.store.get();
    if (!cfg.twitchClientId) {
      res.status(400).json({ error: "Twitch Client ID not configured." });
      return;
    }
    if (!cfg.twitchChannel) {
      res.status(400).json({ error: "Not authorized yet — finish the Login with Twitch step first." });
      return;
    }
    const tokens = loadAllTokens(ctx.tokensFile);
    const broadcasterEntry = Object.entries(tokens).find(
      ([, t]) => t.scope.includes("channel:read:redemptions") || t.scope.includes("channel:manage:redemptions"),
    );
    if (!broadcasterEntry) {
      res.status(400).json({ error: "Authorized user does not have the required reward scopes." });
      return;
    }
    const [userId, t] = broadcasterEntry;
    try {
      const ap = new StaticAuthProvider(cfg.twitchClientId, t.accessToken, t.scope);
      const api = new ApiClient({ authProvider: ap });
      const rewards = await api.channelPoints.getCustomRewards(userId);
      res.json({
        rewards: rewards.map((r) => ({
          id: r.id,
          title: r.title,
          cost: r.cost,
          prompt: r.prompt,
          isEnabled: r.isEnabled,
          userInputRequired: r.userInputRequired,
          backgroundColor: r.backgroundColor,
        })),
        loggedRewardIds: cfg.loggedRewardIds ?? [],
        musicRewardId: cfg.musicRewardId ?? "",
      });
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`failed to fetch rewards: ${msg}`);
      res.status(500).json({ error: `Could not load rewards: ${msg}` });
    }
  });

  router.post("/setup/api/rewards", express.json(), (req, res) => {
    const body = req.body as { loggedRewardIds?: string[]; musicRewardId?: string };
    const loggedRewardIds = Array.isArray(body.loggedRewardIds)
      ? body.loggedRewardIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    const musicRewardId = typeof body.musicRewardId === "string" ? body.musicRewardId : "";
    ctx.store.update({ loggedRewardIds, musicRewardId });
    res.json({ ok: true });
  });

  router.post("/setup/api/sheets", express.json(), (req, res) => {
    const url = String((req.body as { url?: string }).url ?? "").trim();
    ctx.store.update({ googleSheetsWebhook: url });
    res.json({ ok: true });
  });

  router.post("/setup/api/finalize", express.json(), async (req, res) => {
    // Triggered when the user finishes the wizard. We try to start (or hot-restart)
    // the rest of the bot so they don't need to manually restart Railway/Docker.
    res.json({ ok: true });
    try {
      await ctx.onConfigChange();
    } catch (err) {
      log.error(`onConfigChange failed: ${(err as Error).message}`);
    }
  });

  return router;
}

function buildState(ctx: SetupContext, req: Request): WizardState {
  const cfg = ctx.store.get();
  const publicUrl = effectivePublicUrl(cfg.publicUrl, req);
  const tokens = loadAllTokens(ctx.tokensFile);
  const hasTokens = Object.keys(tokens).length > 0;
  const hasClientCreds = Boolean(cfg.twitchClientId && cfg.twitchClientSecret);
  const overlayToken = cfg.overlayToken ?? "";

  return {
    hasClientCreds,
    hasTokens,
    ready: hasClientCreds && hasTokens && Boolean(cfg.twitchChannel),
    channelLogin: cfg.twitchChannel ?? "",
    botLogin: cfg.twitchBotLogin ?? cfg.twitchChannel ?? "",
    publicUrl,
    redirectUri: `${publicUrl}/setup/oauth/callback`,
    overlayUrl: overlayToken ? `${publicUrl}/overlay?token=${overlayToken}` : "",
    rewardCount: cfg.loggedRewardIds?.length ?? 0,
    loggedRewardIds: cfg.loggedRewardIds ?? [],
    musicRewardId: cfg.musicRewardId ?? "",
    googleSheetsWebhook: cfg.googleSheetsWebhook ?? "",
    authorizedUsers: Object.values(tokens).map((t) => ({
      userId: t.userId,
      userLogin: "",
      userDisplay: "",
      scopes: t.scope,
    })),
  };
}

function effectivePublicUrl(persisted: string | undefined, req: Request): string {
  if (persisted) return persisted.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function sanitizePublicUrl(u: string): string {
  const trimmed = u.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return trimmed;
  } catch {
    return "";
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = decodeURIComponent(part.slice(eq + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function respondCallback(res: Response, ok: boolean, message: string): void {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(ok ? 200 : 400).send(`<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>${ok ? "Готово" : "Ошибка"}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: #0f1115; color: #e6e6e6; padding: 1rem; }
  .card { background: #1c1f26; padding: 2rem; border-radius: 12px; max-width: 460px; text-align: center; border: 1px solid ${ok ? "#3a7d3a" : "#7d3a3a"}; }
  h1 { margin: 0 0 .5rem; color: ${ok ? "#7ee27e" : "#ff8888"}; }
</style></head>
<body>
  <div class="card">
    <h1>${ok ? "Готово" : "Ошибка"}</h1>
    <p>${message}</p>
    <p><small>Эта вкладка скоро закроется автоматически.</small></p>
  </div>
  <script>
    setTimeout(function(){
      try { window.opener && window.opener.postMessage({type: 'dearbot-oauth', ok: ${ok ? "true" : "false"}}, '*'); } catch(e){}
      window.close();
      setTimeout(function(){ window.location.href = '/setup'; }, 300);
    }, 1500);
  </script>
</body></html>`);
}
