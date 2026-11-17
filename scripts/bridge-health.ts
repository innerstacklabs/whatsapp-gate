#!/usr/bin/env node
// Health of the WhatsApp bridge, from two signals a process supervisor cannot see together:
//   1. the REST port answers (any HTTP status, a 404 included, means the server is up);
//   2. the bridge's log has no logged-out, unpaired or QR line after its last "connected" line.
// WhatsApp can unlink the device (the human removes it, or the phone is offline about 14 days) while the bridge
// process stays up, so a running process is not proof that messages arrive.
// Usage: node scripts/bridge-health.ts
// Exit 0 = pass, 1 = fail, 2 = unknown (could not measure; never read that as pass or fail).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig } from "../lib/config.ts";

export type Verdict = "pass" | "fail" | "unknown";
export interface Finding { verdict: Verdict; reasons: string[] }

const CONNECTED = /Connected to WhatsApp!|Successfully connected to WhatsApp servers/;
const UNLINKED = /logged.?out|log.?out|unpair|QR code/i;

/** Verdict from the log text alone: a bad line after the last connected line means the device is unlinked. */
export function logVerdict(text: string): Finding {
  const lines = text.split("\n");
  let lastConnected = -1;
  lines.forEach((l, i) => { if (CONNECTED.test(l)) lastConnected = i; });
  if (lastConnected < 0) return { verdict: "unknown", reasons: ["log has no connected line"] };
  const bad = lines.slice(lastConnected + 1).filter((l) => UNLINKED.test(l));
  return bad.length ? { verdict: "fail", reasons: [`unlinked: ${bad[0].replace(/\x1b\[[0-9;]*m/g, "").trim().slice(0, 80)}`] } : { verdict: "pass", reasons: [] };
}

export function combine(parts: Finding[]): Finding {
  const reasons = parts.flatMap((p) => p.reasons);
  const verdict: Verdict = parts.some((p) => p.verdict === "fail") ? "fail" : parts.some((p) => p.verdict === "unknown") ? "unknown" : "pass";
  return { verdict, reasons };
}

async function restFinding(url: string): Promise<Finding> {
  try {
    await fetch(`${url}/`, { signal: AbortSignal.timeout(8000), redirect: "error" });
    return { verdict: "pass", reasons: [] };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const code = String(cause?.code ?? "");
    const why = code || (/redirect/i.test(String(cause?.message ?? "")) ? "redirect refused" : "timeout");
    return code === "ECONNREFUSED" ? { verdict: "fail", reasons: ["REST port refuses"] } : { verdict: "unknown", reasons: [`REST probe inconclusive (${why})`] };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let f: Finding;
  try {
    const cfg = loadConfig(configPath());
    let log: Finding;
    try { log = logVerdict(readFileSync(cfg.bridgeLog, "utf8")); } catch { log = { verdict: "unknown", reasons: ["log unreadable"] }; }
    f = combine([await restFinding(cfg.bridgeUrl), log]);
  } catch (e) { f = { verdict: "unknown", reasons: [(e as Error).message] }; }
  console.log(`whatsapp-bridge: ${f.verdict}${f.reasons.length ? ` (${f.reasons.join("; ")})` : ""}`);
  process.exit(f.verdict === "pass" ? 0 : f.verdict === "fail" ? 1 : 2);
}
