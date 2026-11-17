// The one config file that the hook, the sender and the reader all read.
// The path is ~/.config/whatsapp-gate/config.json for every program, so the ask names the contact the sender sends to.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

export interface Config {
  /** JSON file of the contacts that may receive a message. */
  allowlist: string;
  /** The bridge's REST API, on this machine only. */
  bridgeUrl: string;
  /** File that holds the bridge's bearer token. */
  tokenFile: string;
  /** The bridge's SQLite message store, read by whatsapp-recent. */
  messagesDb: string;
  /** The bridge's log, read by bridge-health. */
  bridgeLog: string;
  /** The one directory the bridge sends files from (its WHATSAPP_MEDIA_ROOTS). */
  outbox: string;
  /** Where the sender appends its log of attempts. */
  logDir: string;
  /** Optional: only a process whose environment has `env` set to `value` may send. */
  sender: { env: string; value: string } | null;
  /** Optional: a command (argv, no shell) that exits 0 when the human is at the keyboard. */
  presence: string[] | null;
}

export function configPath(): string {
  return join(homedir(), ".config", "whatsapp-gate", "config.json");
}

/** The values install.ts writes, and the values a config file that omits a field gets. */
export function defaults(): Omit<Config, "sender" | "presence"> {
  const home = homedir();
  return {
    allowlist: join(home, ".config", "whatsapp-gate", "allowlist.json"),
    bridgeUrl: "http://127.0.0.1:8790/api",
    tokenFile: join(home, ".local", "share", "whatsapp-bridge", "store", ".bridge-token"),
    messagesDb: join(home, ".local", "share", "whatsapp-bridge", "store", "messages.db"),
    bridgeLog: join(home, ".local", "share", "whatsapp-bridge", "bridge.log"),
    outbox: join(home, ".local", "share", "whatsapp-mcp", "outbox"),
    logDir: join(home, ".local", "state", "whatsapp-gate"),
  };
}

const PATH_FIELDS = ["allowlist", "tokenFile", "messagesDb", "bridgeLog", "outbox", "logDir"] as const;
const KNOWN = new Set<string>([...PATH_FIELDS, "bridgeUrl", "sender", "presence"]);

// A misspelled policy field would otherwise read as "no policy", so an unknown key is an error.
export function parseConfig(raw: unknown, source: string): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${source}: the config must be a JSON object`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN.has(k)) throw new Error(`${source}: unknown field ${JSON.stringify(k)}`);
  const cfg: Config = { ...defaults(), sender: null, presence: null };
  for (const f of PATH_FIELDS) {
    if (o[f] === undefined) continue;
    const v = o[f];
    if (typeof v !== "string" || !isAbsolute(v) || normalize(v) !== v) throw new Error(`${source}: ${f} must be a normalized absolute path`);
    cfg[f] = v;
  }
  if (o.bridgeUrl !== undefined) {
    let u: URL;
    const raw = String(o.bridgeUrl);
    try { u = new URL(raw); } catch { throw new Error(`${source}: bridgeUrl is not a URL`); }
    if (/[?#]/.test(raw) || u.username !== "" || u.password !== "") {
      throw new Error(`${source}: bridgeUrl may not hold a query string, a fragment or a user name and password`);
    }
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
      throw new Error(`${source}: bridgeUrl must be http on 127.0.0.1, localhost or [::1]; the token is sent to it`);
    }
    // The hook recognizes a direct call by the /api/ path, so the sender may not use another one.
    if (u.pathname.replace(/\/+$/, "") !== "/api") throw new Error(`${source}: bridgeUrl must end in /api`);
    // The hook recognizes a direct call to the bridge by its port number, so the port must be named and not a well-known one.
    if (u.port === "" || Number(u.port) < 1024) {
      throw new Error(`${source}: bridgeUrl must name a port of 1024 or higher; the hook recognizes a direct call to the bridge by that number`);
    }
    cfg.bridgeUrl = u.href.replace(/\/+$/, "");
  }
  if (o.sender !== undefined) {
    const s = o.sender as { env?: unknown; value?: unknown } | null;
    if (!s || typeof s !== "object" || Object.keys(s).sort().join() !== "env,value" || typeof s.env !== "string" || typeof s.value !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.env) || s.value === "") {
      throw new Error(`${source}: sender must be {"env": "<variable name>", "value": "<non-empty value>"}`);
    }
    cfg.sender = { env: s.env, value: s.value };
  }
  if (o.presence !== undefined) {
    const p = o.presence;
    if (!Array.isArray(p) || p.length === 0 || p.some((x) => typeof x !== "string" || x === "") || !isAbsolute(p[0] as string)) {
      throw new Error(`${source}: presence must be a non-empty array of strings whose first item is an absolute path`);
    }
    cfg.presence = p as string[];
  }
  return cfg;
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    if (!statSync(path).isFile()) throw new Error("not a plain file");
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) { throw new Error(`cannot read the config ${path}: ${(e as Error).message}`); }
  return parseConfig(raw, path);
}
