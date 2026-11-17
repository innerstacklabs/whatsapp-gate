// Shared setup for the tests: a scratch HOME with a config, an allowlist and nothing that can reach a real bridge
// (the bridge URL points at a closed port and no token file exists).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

// A port nothing listens on: a real port is opened and closed to pick one (a config needs a port of 1024 or higher).
export const CLOSED_PORT: number = await new Promise<number>((ok) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => ok(port)); });
});

export const sha =(b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
export const cp = (...n: number[]): string => String.fromCodePoint(...n);
export const PAT = { jid: "15550100@s.whatsapp.net", name: "Pat Example" };

export interface Scratch { home: string; config: string; outbox: string; logDir: string }

export function scratch(extra: Record<string, unknown> = {}, contacts: Record<string, unknown> = { pat: PAT }): Scratch {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wa-gate-")));
  const config = join(home, ".config", "whatsapp-gate", "config.json");
  const s = { home, config, outbox: join(home, "outbox"), logDir: join(home, "log") };
  mkdirSync(join(home, ".config", "whatsapp-gate"), { recursive: true });
  writeFileSync(join(home, "allow.json"), JSON.stringify({ contacts }));
  writeFileSync(config, JSON.stringify({
    allowlist: join(home, "allow.json"), bridgeUrl: `http://127.0.0.1:${CLOSED_PORT}/api`, tokenFile: join(home, "no-token"),
    outbox: s.outbox, logDir: s.logDir, ...extra,
  }));
  return s;
}

/** The environment of a child process: this scratch HOME, and none of the variables the tests set one by one. */
export function envFor(s: Scratch, more: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: s.home, ...more };
  if (!("GATE_TEST_AGENT" in more)) delete env.GATE_TEST_AGENT;
  return env;
}
