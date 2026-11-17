#!/usr/bin/env node
// gate-whatsapp-send.ts: Claude Code PreToolUse(Bash) hook for WhatsApp sends.
// An agent may send to an allowlisted contact only through scripts/whatsapp-send.ts in its one canonical shape,
// only from the main session (not a subagent), only when the optional `sender` and `presence` policies in the
// config allow it, and every send is an `ask` that shows the human the exact text. Everything else that runs the
// sender, or calls the bridge's acting API directly, is denied, and so is any failure once the command is known to
// concern the gate. No decision (exit 0, no output) for a command that touches neither, or for input it cannot parse.
import { readFileSync } from "node:fs";
import { configPath, loadConfig } from "../lib/config.ts";
import { CANONICAL, humanPresent, isOurSender, loadAllowlist, readAttachment, readMessage, sha256 } from "../lib/whatsapp.ts";

type Decision = "ask" | "deny";

function decide(decision: Decision, reason: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

let input: { tool_input?: { command?: unknown }; agent_id?: string; cwd?: string } | null;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const raw = input?.tool_input?.command;
const cmd = typeof raw === "string" ? raw.trim() : "";
if (cmd === "") process.exit(0);

// Runs the sender: an interpreter followed by `whatsapp-send.ts` anywhere, or the file executed at the start of a
// command. `git add scripts/whatsapp-send.ts` is not a run. The first pattern over-matches (the interpreter followed
// later by the file name anywhere in the command counts) and is denied with the command shape, the safe direction.
// Only the file name is matched in any letter case (built from character classes), so a case variant of the name is
// denied as non-canonical, and CANONICAL stays case-sensitive. The interpreter word is matched exactly everywhere
// except where it is the command (the start, after ; & | ( or after env, exec or command, with a directory path in
// front), where any letter case counts: on a case-insensitive file system `Node` runs node.
const blind = (s: string): string => s.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const NAME = blind("whatsapp-send.ts").replace(".", "\\.");
const INTERPRETERS = "node|nodejs|tsx|bun|deno";
const namesSender = new RegExp(String.raw`\b(${INTERPRETERS})\s+(?:\S+\s+)*?\S*${NAME}\b`).test(cmd) ||
  new RegExp(String.raw`(?:^|[;&|(]\s*|\b(?:env|exec|command)\s+)(?:\S*\/)?(?:${INTERPRETERS.split("|").map(blind).join("|")})\s+(?:\S+\s+)*?\S*${NAME}\b`).test(cmd) ||
  new RegExp(String.raw`(^|[;&|(]\s*)(\.\/|\S*\/)?(scripts\/)?${NAME}\b`).test(cmd);

// A direct call to a route of the bridge that acts: /api/ and a route name (any number of slashes between them, any
// letter case) in a command that holds the bridge's port as a number: the configured one, or 8790, its default. Another
// local service is not the gate's business. A call through a port forward or a proxy on another port is not seen,
// and a percent-encoded path is not decoded.
const API_ROUTE = /\/+api\/+(?:send|react|typing|mark-read|edit|delete)\b/i;
function bridgePorts(): string[] {
  const ports = ["8790"];
  try { ports.push(new URL(loadConfig(configPath()).bridgeUrl).port); } catch { /* an unreadable config leaves the default port */ }
  return ports.filter((p) => p !== "");
}
const hitsBridgeApi = API_ROUTE.test(cmd) && bridgePorts().some((p) => new RegExp(`(?<![0-9])${p}(?![0-9])`).test(cmd));
if (!namesSender && !hitsBridgeApi) process.exit(0);

function check(): never {
  if (hitsBridgeApi && !namesSender) {
    decide("deny", "WhatsApp sends go only through scripts/whatsapp-send.ts, which the human approves per message. Direct calls to the bridge's API are denied.");
  }
  const m = CANONICAL.exec(cmd);
  if (!m) {
    decide("deny", "whatsapp-send.ts runs only as: node scripts/whatsapp-send.ts --to <name> --text-file <abs path> --sha256 <hex> [--attach <abs path> --attach-sha256 <hex>], alone in the command.");
  }
  if (input?.agent_id) decide("deny", "A subagent never sends WhatsApp. Draft it for the main session.");
  let cfg;
  try { cfg = loadConfig(configPath()); } catch (e) { decide("deny", (e as Error).message); }
  if (cfg.sender && process.env[cfg.sender.env] !== cfg.sender.value) {
    decide("deny", `Only the session whose ${cfg.sender.env} is set to the configured value may send WhatsApp. Hand the approved text to that session.`);
  }
  const [, prefix, to, file, wantSha, attachPath, attachSha] = m as unknown as [string, string, string, string, string, string | undefined, string | undefined];
  if (!isOurSender(prefix, input?.cwd)) {
    decide("deny", "The command names a whatsapp-send.ts that is not this checkout's scripts/whatsapp-send.ts (run it from the checkout, or by its full path).");
  }
  let contact;
  try { contact = loadAllowlist(cfg.allowlist)[to]; } catch (e) { decide("deny", `cannot read the allowlist: ${(e as Error).message}`); }
  if (!contact) decide("deny", `'${to}' is not in the allowlist; adding a contact needs the human's yes.`);
  let text: string;
  try { text = readMessage(file); } catch (e) { decide("deny", `cannot read the message: ${(e as Error).message}`); }
  if (sha256(text) !== wantSha) decide("deny", "the --sha256 does not match the message file.");
  // One file may ride with the text as its caption. The human sees its name, size, path and hash, and the sender sends those bytes.
  let attachLine = "";
  if (attachPath !== undefined) {
    let att;
    try { att = readAttachment(attachPath); } catch (e) { decide("deny", `cannot read the attachment: ${(e as Error).message}`); }
    if (att.sha256 !== attachSha) decide("deny", "the --attach-sha256 does not match the attachment file.");
    // The file line goes ABOVE the text, so nothing in the text can come before it or hide it.
    attachLine = `WITH THIS FILE ATTACHED: ${att.name} (${att.bytes.length} bytes, sha256 ${att.sha256.slice(0, 12)})\nfrom ${att.path}\n\nand this text as its caption:\n\n`;
  }
  if (!humanPresent(cfg)) decide("deny", "The presence command did not exit 0, so nobody can approve this send. It waits until the human is at the keyboard.");

  decide("ask", `Send this WhatsApp message from your own number to ${contact.name} (${contact.jid})?\n\n${attachLine}${text}\n\n(${text.length} characters, sha256 ${wantSha.slice(0, 12)})`);
}

// An exception here (a presence argument that cannot be run, an unreadable file) is not a pass: Claude Code reads
// a hook that exits 1 as a non-blocking error and runs the command.
try { check(); } catch (e) { decide("deny", `the hook failed, so the command is denied: ${(e as Error).message}`); }
