#!/usr/bin/env node
// Sets up the files this repository needs and prints the Claude Code hook block to paste. It downloads nothing,
// starts nothing and edits no Claude Code settings.
//   1. writes the config file if it is absent (an existing one is validated and never changed);
//   2. creates the allowlist with an empty contact list if it is absent;
//   3. creates the outbox directory (mode 0700);
//   4. checks that the bridge answers on its URL;
//   5. prints the settings.json block.
// Usage: node scripts/install.ts [--skip-bridge-check]
// Exit 0 = ready, 1 = a file could not be written or the config is invalid, 3 = files are ready but the bridge does not answer.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, defaults, loadConfig } from "../lib/config.ts";

const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`install: Node 22.18 or later is required (this is ${process.versions.node}); it runs .ts files without a build step.`);
  process.exit(1);
}

// Creates the file only when nothing is at the path: the exclusive flag also refuses a dangling symlink, which a
// check for existence followed by a write would follow to its target.
function createOnce(path: string, content: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, content, { mode: 0o600, flag: "wx" }); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
}

try {
  const path = configPath();
  console.log(createOnce(path, JSON.stringify(defaults(), null, 2) + "\n") ? `config: wrote ${path}` : `config: kept ${path}`);
  const cfg = loadConfig(path);
  console.log(createOnce(cfg.allowlist, JSON.stringify({ contacts: {} }, null, 2) + "\n")
    ? `allowlist: created ${cfg.allowlist} with no contacts; add one by hand (see the README)` : `allowlist: kept ${cfg.allowlist}`);
  mkdirSync(cfg.outbox, { recursive: true, mode: 0o700 });
  console.log(`outbox: ${cfg.outbox}`);

  let answered = true;
  if (process.argv.includes("--skip-bridge-check")) console.log("bridge: not checked");
  else try {
    await fetch(`${cfg.bridgeUrl}/`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    console.log(`bridge: answers on ${cfg.bridgeUrl}`);
  } catch (e) {
    answered = false;
    console.log(`bridge: NO ANSWER on ${cfg.bridgeUrl} (${(e as Error).message}); start the bridge (README, step 3) before the first send`);
  }

  const hook = fileURLToPath(new URL("../hooks/gate-whatsapp-send.ts", import.meta.url));
  const block = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "${hook}"` }] }] } };
  console.log("\nAdd this to the settings.json of the Claude Code project or user that runs the agent (merge it with any hooks already there):\n");
  console.log(JSON.stringify(block, null, 2));
  process.exit(answered ? 0 : 3);
} catch (e) {
  console.error(`install: ${(e as Error).message}`);
  process.exit(1);
}
