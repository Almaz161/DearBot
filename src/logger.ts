type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  currentLevel = LEVELS[level];
}

function fmt(level: Level, scope: string, msg: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  const extraStr = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  return `[${ts}] ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extraStr}`;
}

export function makeLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => {
      if (LEVELS.debug >= currentLevel) console.log(fmt("debug", scope, msg, extra));
    },
    info: (msg: string, extra?: unknown) => {
      if (LEVELS.info >= currentLevel) console.log(fmt("info", scope, msg, extra));
    },
    warn: (msg: string, extra?: unknown) => {
      if (LEVELS.warn >= currentLevel) console.warn(fmt("warn", scope, msg, extra));
    },
    error: (msg: string, extra?: unknown) => {
      if (LEVELS.error >= currentLevel) console.error(fmt("error", scope, msg, extra));
    },
  };
}

export type Logger = ReturnType<typeof makeLogger>;
