#!/usr/bin/env node
// Recent WhatsApp messages from the linked-device bridge, read-only from its SQLite store.
// Exit contract, so a caller can tell a quiet window from a failed read:
//   exit 0 = read OK (stdout may be empty: a quiet window)
//   exit 2 + stderr "CANNOT READ - ..." = the bridge or its store is down; nothing was read
//   exit 2 + stderr "TRUNCATED - ..."   = read OK but capped at --limit; stdout is EMPTY; raise --limit
// Usage: node scripts/whatsapp-recent.ts [--hours N (default 7)] [--limit N (default 300)] [--all] [--json]
//   --all includes messages you sent (marked "->"); default is inbound only ("<-").
import { existsSync } from "node:fs";
import { configPath, loadConfig } from "../lib/config.ts";

// node:sqlite prints an ExperimentalWarning on load; drop warnings before loading it so stderr carries only the contract lines.
process.removeAllListeners("warning");
const { DatabaseSync } = await import("node:sqlite");

interface Row { chat_jid: string; chat_name: string | null; sender: string; ts: string; from_me: number; content: string | null; media_type: string | null }

function cannotRead(msg: string): never { process.stderr.write(`CANNOT READ - ${msg}\n`); process.exit(2); }

const argv = process.argv.slice(2);
function opt(name: string, def: number): number {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) { process.stderr.write(`usage: ${name} takes a positive integer\n`); process.exit(1); }
  return n;
}
const hours = opt("--hours", 7);
const limit = opt("--limit", 300);
const all = argv.includes("--all");
const asJson = argv.includes("--json");

let cfg;
try { cfg = loadConfig(configPath()); } catch (e) { cannotRead((e as Error).message); }
if (!existsSync(cfg.messagesDb)) cannotRead(`no store at ${cfg.messagesDb}`);
// The bridge answers 404 on /api/ when it is up; a refused connection means it is down.
try { await fetch(`${cfg.bridgeUrl}/`, { signal: AbortSignal.timeout(5000), redirect: "error" }); }
catch (e) { cannotRead(`the bridge on ${cfg.bridgeUrl} did not answer (${(e as Error).message}); messages after it stopped are missing`); }

const since = new Date(Date.now() - hours * 3600_000).toISOString();
let rows: Row[];
try {
  const db = new DatabaseSync(cfg.messagesDb, { readOnly: true });
  rows = db.prepare(
    `select m.chat_jid, c.name as chat_name, m.sender, m.timestamp as ts, m.is_from_me as from_me, m.content, m.media_type
       from messages m left join chats c on c.jid = m.chat_jid
      where datetime(m.timestamp) >= datetime(?) ${all ? "" : "and m.is_from_me = 0"}
      order by m.timestamp asc limit ?`,
  ).all(since, limit + 1) as unknown as Row[];
  db.close();
} catch (e) { cannotRead(`the store did not read: ${(e as Error).message}`); }

if (rows.length > limit) {
  process.stderr.write(`TRUNCATED - more than ${limit} messages in ${hours}h; rerun with a higher --limit or a smaller --hours\n`);
  process.exit(2);
}
if (asJson) { process.stdout.write(JSON.stringify(rows, null, 1) + "\n"); process.exit(0); }
for (const r of rows) {
  const label = r.chat_name || r.chat_jid;
  const where = r.chat_jid.endsWith("@g.us") ? `group "${label}"` : label;
  const body = (r.content ?? "").replace(/\s+/g, " ").trim() || `[${r.media_type ?? "no text"}]`;
  process.stdout.write(`${r.ts} ${r.from_me ? "->" : "<-"} ${where}${r.chat_jid.endsWith("@g.us") ? ` (${r.sender})` : ""}: ${body}\n`);
}
