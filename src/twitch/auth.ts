import { RefreshingAuthProvider, type AccessToken } from "@twurple/auth";
import fs from "node:fs";
import path from "node:path";

export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  scope: string[];
  expiresIn: number;
  obtainmentTimestamp: number;
  userId: string;
};

export type TokenStore = Record<string, StoredTokens>;

function readStore(filePath: string): TokenStore {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as TokenStore;
  } catch {
    return {};
  }
}

function writeStore(filePath: string, store: TokenStore): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
}

export function saveTokens(filePath: string, userId: string, tokens: StoredTokens): void {
  const store = readStore(filePath);
  store[userId] = tokens;
  writeStore(filePath, store);
}

export function loadTokensForUser(filePath: string, userId: string): StoredTokens | null {
  const store = readStore(filePath);
  return store[userId] ?? null;
}

export function loadAllTokens(filePath: string): TokenStore {
  return readStore(filePath);
}

export function createAuthProvider(
  clientId: string,
  clientSecret: string,
  tokensFile: string,
): RefreshingAuthProvider {
  const provider = new RefreshingAuthProvider({ clientId, clientSecret });
  provider.onRefresh((userId, newTokens) => {
    const stored: StoredTokens = {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken ?? "",
      scope: newTokens.scope ?? [],
      expiresIn: newTokens.expiresIn ?? 0,
      obtainmentTimestamp: newTokens.obtainmentTimestamp,
      userId,
    };
    saveTokens(tokensFile, userId, stored);
  });
  return provider;
}

export function tokensToAccessToken(t: StoredTokens): AccessToken {
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    scope: t.scope,
    expiresIn: t.expiresIn,
    obtainmentTimestamp: t.obtainmentTimestamp,
  };
}
