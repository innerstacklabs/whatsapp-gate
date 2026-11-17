#!/usr/bin/env node
// Sends ONE WhatsApp message from the linked account through the local bridge: a text, or one file with the text as its caption.
// Usage: node scripts/whatsapp-send.ts --to <allowlisted name> --text-file <abs path> --sha256 <hex of the text>
//          [--attach <abs path> --attach-sha256 <hex of the file's bytes>]
//
// The PreToolUse hook (hooks/gate-whatsapp-send.ts) shows the human the exact text and waits for a yes. This script
// re-checks what it can on its own: the allowlist, the canonical arguments, the text hash and the presence command.
// Every request sent to the bridge is logged to <logDir>/whatsapp-sends.jsonl (the hash and length, not the text),
// an unanswered one included, with success null: its outcome is unknown.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../lib/config.ts";
import { bridgeToken, humanPresent, loadAllowlist, readAttachment, readMessage, sha256 } from "../lib/whatsapp.ts";

function fail(msg: string, code = 1): never {
  process.stderr.write(`whatsapp-send: REFUSED: ${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
const withAttach = args.length === 10 && args[6] === "--attach" && args[8] === "--attach-sha256";
if ((args.length !== 6 && !withAttach) || args[0] !== "--to" || args[2] !== "--text-file" || args[4] !== "--sha256") {
  fail("usage: whatsapp-send.ts --to <name> --text-file <abs path> --sha256 <hex> [--attach <abs path> --attach-sha256 <hex>]", 2);
}
const [, to, , file, , wantSha, , attachPath, , attachSha] = args as [string, string, string, string, string, string, string?, string?, string?, string?];

let cfg;
try { cfg = loadConfig(configPath()); } catch (e) { fail((e as Error).message); }
let contact;
try { contact = loadAllowlist(cfg.allowlist)[to]; } catch (e) { fail(`cannot read the allowlist: ${(e as Error).message}`); }
if (!contact) fail(`'${to}' is not in the allowlist ${cfg.allowlist}`);

let text: string;
try { text = readMessage(file); } catch (e) { fail((e as Error).message); }
const gotSha = sha256(text);
if (gotSha !== wantSha) fail("the text file changed since it was approved (sha256 mismatch)");

if (!humanPresent(cfg)) fail("the presence command did not exit 0, so nobody is here to have approved this");

// The bridge reads the attachment by path. It gets a private copy of the bytes that were hashed here,
// under the file's own name, so a change to the original after approval cannot change what is sent.
let media: { path: string; name: string; bytes: number; sha256: string } | null = null;
if (withAttach) {
  let att;
  try { att = readAttachment(attachPath as string); } catch (e) { fail((e as Error).message); }
  if (att.sha256 !== attachSha) fail("the attachment changed since it was approved (sha256 mismatch)");
  // The copy lives in a fresh directory under the bridge's outbox, the only place it sends files from, and is removed
  // when this process exits, however it exits (fail() calls process.exit, which skips a finally block).
  mkdirSync(cfg.outbox, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(cfg.outbox, "send-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => process.exit(130));
  writeFileSync(join(dir, att.name), att.bytes, { mode: 0o600 });
  media = { path: join(dir, att.name), name: att.name, bytes: att.bytes.length, sha256: att.sha256 };
}
let token: string;
try { token = bridgeToken(cfg); } catch (e) { fail(`cannot read the bridge token ${cfg.tokenFile}: ${(e as Error).message}`); }
// A log that cannot be written never turns a sent message into a reported failure.
const record = (outcome: Record<string, unknown>): void => {
  try {
    mkdirSync(cfg.logDir, { recursive: true });
    appendFileSync(join(cfg.logDir, "whatsapp-sends.jsonl"), JSON.stringify({
      ts: new Date().toISOString(), to, jid: contact.jid, sha256: gotSha, chars: text.length,
      ...(media ? { attach: media.name, attachBytes: media.bytes, attachSha256: media.sha256 } : {}), ...outcome,
    }) + "\n");
  } catch (e) { process.stderr.write(`whatsapp-send: warning: the log was not written: ${(e as Error).message}\n`); }
};
// Ten minutes is far past a 64 MiB upload; without a limit a stuck bridge holds the copy and the terminal.
const res = await fetch(`${cfg.bridgeUrl}/send`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ recipient: contact.jid, message: text, ...(media ? { media_path: media.path } : {}) }),
  signal: AbortSignal.timeout(600_000),
  redirect: "error",
}).catch((e: Error) => {
  record({ http: null, success: null, bridge: `no answer: ${e.message}` });
  return fail(`no answer from the bridge (${e.message}). The outcome is UNKNOWN: the message may still go out. Read the thread before any retry`);
});
const body = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
record({ http: res.status, success: body.success === true, bridge: body.message ?? null });
if (!res.ok || body.success !== true) fail(`the bridge said ${res.status}: ${body.message ?? "no message"}`);
process.stdout.write(`whatsapp-send: SENT to ${contact.name} (${contact.jid}), ${text.length} chars${media ? `, with ${media.name} (${media.bytes} bytes)` : ""}\n`);
