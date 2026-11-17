// Rules shared by hooks/gate-whatsapp-send.ts and scripts/whatsapp-send.ts, so the hook and the sender agree on one
// canonical command shape, one allowlist, one text hash and one set of allowed characters.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

export interface Contact { jid: string; name: string }

// This checkout. The gate accepts the sender only by a path that resolves to this file.
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
export const SENDER_PATH = join(REPO_ROOT, "scripts", "whatsapp-send.ts");

// The only command shape the gate asks about; anything else that names the sender is denied.
// Paths take only characters the shell passes through unchanged, so the path the hook reads is the path the
// sender gets: no glob, variable, quote, bracket or separator.
// The script is named `scripts/whatsapp-send.ts`, `./scripts/whatsapp-send.ts` or by an absolute path in the same
// characters; group 1 is that prefix, and isOurSender() checks it resolves to this checkout's file, not another one of the same name.
const PATH = String.raw`\/[A-Za-z0-9._\/+@-]+`;
export const CANONICAL = new RegExp(
  String.raw`^node ((?:\.\/|${PATH}\/)?)scripts\/whatsapp-send\.ts --to ([a-z][a-z0-9-]*) --text-file (${PATH}) --sha256 ([0-9a-f]{64})(?: --attach (${PATH}) --attach-sha256 ([0-9a-f]{64}))?$`,
);

// True when the command's script path, read from the directory the command runs in, is this checkout's sender:
// the same file on disk, symlinks followed. A `..` is refused first, because the kernel follows a symlink before
// it steps up and a textual resolve does not, so the two could name different files.
export function isOurSender(prefix: string, cwd: string | undefined): boolean {
  const from = prefix.startsWith("/") ? "/" : cwd;
  if (!from || `${from}/${prefix}`.split("/").includes("..")) return false;
  try {
    return realpathSync(resolve(from, `${prefix}scripts/whatsapp-send.ts`)) === realpathSync(SENDER_PATH);
  } catch { return false; }
}

export const ATTACH_MAX_BYTES = 64 * 1024 * 1024;
export const MESSAGE_MAX_CHARS = 4000;
// Kinds whose caption the recipient sees with the file. Audio is left out: its caption is unverified.
export const ATTACH_KINDS = [".mp4", ".png", ".jpg", ".jpeg", ".pdf", ".md", ".txt"];
export interface Attachment { path: string; name: string; bytes: Buffer; sha256: string }

// Reads the file to attach. Refuses anything but a plain file of a listed kind named by its real, normalized
// absolute path: a symlink anywhere in the path, a directory, an empty file and one over the size limit all throw.
export function readAttachment(path: string): Attachment {
  if (!path.startsWith("/") || normalize(path) !== path) throw new Error(`the attachment path is not a normalized absolute path: ${path}`);
  if (!ATTACH_KINDS.includes(extname(path))) throw new Error(`the attachment's kind is not one of ${ATTACH_KINDS.join(" ")}: ${path}`);
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`the attachment is not a plain file (a symlink or directory is refused): ${path}`);
  if (realpathSync(path) !== path) throw new Error(`the attachment path goes through a symlink: ${path}`);
  if (st.size === 0) throw new Error("the attachment is empty");
  if (st.size > ATTACH_MAX_BYTES) throw new Error(`the attachment is ${st.size} bytes; the limit here is ${ATTACH_MAX_BYTES}`);
  const bytes = readFileSync(path);
  return { path, name: basename(path), bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// What a message may contain is an ALLOWLIST (a deny list cannot name every invisible character):
// newline, tab, printable ASCII, the Latin-1 letters and signs, and a few typographic marks. Every one is visible
// and one column wide, so what the human reads in the ask is all that is sent. Emoji, joiners, selectors and every
// other script are refused by name; widen the list deliberately when a real message needs it.
const ALLOWED: [number, number][] = [
  [0x09, 0x0a], [0x20, 0x7e], // tab, newline, printable ASCII
  [0xa1, 0xac], [0xae, 0xff], // Latin-1 signs and letters, without the no-break space and the soft hyphen
  [0x2013, 0x2014], [0x2018, 0x2019], [0x201c, 0x201d], [0x2026, 0x2026], [0x20ac, 0x20ac], // dashes, curly quotes, ellipsis, euro
];
export function firstDisallowed(text: string): { code: string; index: number } | null {
  let index = 0;
  for (const ch of text) {
    const n = ch.codePointAt(0) as number;
    if (!ALLOWED.some(([lo, hi]) => n >= lo && n <= hi)) return { code: `U+${n.toString(16).toUpperCase().padStart(4, "0")}`, index };
    index += ch.length;
  }
  return null;
}

const JID = /^[0-9]+@(s\.whatsapp\.net|g\.us)$/;
const CONTACT_KEY = /^[a-z][a-z0-9-]*$/;

// The allowlist is checked when it loads, so a bad entry fails every send and never reaches an ask.
export function loadAllowlist(path: string): Record<string, Contact> {
  if (!statSync(path).isFile()) throw new Error(`the allowlist is not a plain file: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { contacts?: Record<string, { jid?: unknown; name?: unknown }> };
  const list = parsed.contacts;
  if (!list || typeof list !== "object" || Array.isArray(list)) throw new Error(`no contacts in ${path}`);
  // No prototype, so a name such as "constructor" is not a contact.
  const out = Object.create(null) as Record<string, Contact>;
  for (const [key, c] of Object.entries(list)) {
    const label = JSON.stringify(key);
    if (!CONTACT_KEY.test(key)) throw new Error(`allowlist name ${label} must be lower-case letters, digits and hyphens, starting with a letter`);
    if (typeof c?.jid !== "string" || !JID.test(c.jid)) throw new Error(`allowlist entry ${label} has a jid that is not <digits>@s.whatsapp.net or <digits>@g.us`);
    const name = c.name;
    if (typeof name !== "string" || name === "" || name.length > 64 || /[\n\t]/.test(name)) throw new Error(`allowlist entry ${label} needs a name of 1 to 64 characters on one line`);
    const bad = firstDisallowed(name);
    if (bad) throw new Error(`allowlist entry ${label} has a name with a character outside the allowed set: ${bad.code}`);
    out[key] = { jid: c.jid, name };
  }
  return out;
}

// Reads the message file and refuses anything but a plain file, an empty or oversized message, and hidden characters.
export function readMessage(path: string): string {
  if (!statSync(path).isFile()) throw new Error(`the message file is not a plain file: ${path}`);
  const text = readFileSync(path, "utf8").replace(/[ \t\n]+$/, "");
  const bad = firstDisallowed(text);
  if (bad) throw new Error(`the message has a character outside the allowed set: ${bad.code} at character ${bad.index + 1}, counting from 1 (plain Latin text, newline and tab only; no emoji)`);
  if (text.length === 0) throw new Error("the message file is empty");
  if (text.length > MESSAGE_MAX_CHARS) throw new Error(`the message is ${text.length} characters; the limit here is ${MESSAGE_MAX_CHARS}`);
  return text;
}

export function bridgeToken(cfg: Config): string {
  return readFileSync(cfg.tokenFile, "utf8").trim();
}

/** True when no presence command is configured, or the configured command exits 0. */
export function humanPresent(cfg: Config): boolean {
  if (!cfg.presence) return true;
  const [cmd, ...args] = cfg.presence as [string, ...string[]];
  return spawnSync(cmd, args, { stdio: "ignore", timeout: 20_000 }).status === 0;
}
