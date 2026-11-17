// The tools around the gate: install, message-hash, bridge-health's log reading, and whatsapp-recent.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { combine, logVerdict } from "../scripts/bridge-health.ts";
import { CLOSED_PORT, sha, envFor, scratch, type Scratch } from "./helpers.ts";

const runAsync = promisify(execFile);
const script = (name: string) => new URL(`../scripts/${name}`, import.meta.url).pathname;
// Async, so the in-process test bridge can answer while the child runs.
async function node(s: Scratch, name: string, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try { return { code: 0, ...(await runAsync(process.execPath, [script(name), ...args], { env: envFor(s) })) }; }
  catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, stdout: x.stdout, stderr: x.stderr }; }
}
async function bridge(): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => { res.statusCode = 404; res.end(); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
}

test("install writes the config and an empty allowlist, creates the outbox, and prints the hook block", async () => {
  const s = scratch();
  const fresh = join(s.home, "fresh"); // a home directory with no config in it
  const cfgPath = join(fresh, ".config", "whatsapp-gate", "config.json");
  const env = { ...envFor(s), HOME: fresh };
  // The default bridge URL is the real bridge's port on a machine that runs one, so this run does not probe it.
  const { stdout: out } = await runAsync(process.execPath, [script("install.ts"), "--skip-bridge-check"], { env });
  assert.ok(existsSync(cfgPath));
  assert.ok(out.includes("bridge: not checked") && out.includes('"matcher": "Bash"') && out.includes("gate-whatsapp-send.ts"), out);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.deepEqual(JSON.parse(readFileSync(cfg.allowlist, "utf8")), { contacts: {} });
  assert.equal(statSync(cfg.outbox).mode & 0o777, 0o700);
});
test("install never overwrites an existing config or allowlist, and exits 0 when the bridge answers", async () => {
  const s = scratch(), b = await bridge();
  try {
    writeFileSync(s.config, JSON.stringify({ allowlist: join(s.home, "allow.json"), bridgeUrl: b.url, outbox: s.outbox }));
    const before = [readFileSync(s.config, "utf8"), readFileSync(join(s.home, "allow.json"), "utf8")];
    const r = await node(s, "install.ts");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes("config: kept") && r.stdout.includes("allowlist: kept") && r.stdout.includes("bridge: answers"), r.stdout);
    assert.deepEqual([readFileSync(s.config, "utf8"), readFileSync(join(s.home, "allow.json"), "utf8")], before);
  } finally { b.server.close(); }
});
test("install exits 3 and says so when the bridge does not answer, after it has written everything else", async () => {
  const s = scratch();
  const r = await node(s, "install.ts");
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("NO ANSWER") && r.stdout.includes('"matcher": "Bash"'), r.stdout);
});
test("install reports an invalid config and exits 1", async () => {
  const s = scratch({ presense: [] });
  const r = await node(s, "install.ts");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("unknown field"), r.stderr);
});

test("message-hash prints the hash of the trimmed text, and refuses what the gate refuses", () => {
  const s = scratch(), f = join(s.home, "m.txt");
  writeFileSync(f, "hello  \n\n");
  const run = (file: string) => spawnSync(process.execPath, [script("message-hash.ts"), file], { env: envFor(s), encoding: "utf8" });
  assert.equal(run(f).stdout.trim(), sha("hello"));
  writeFileSync(f, `a${String.fromCodePoint(0x1f600)}`);
  const bad = run(f);
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes("U+1F600"), bad.stderr);
});

const line = (m: string) => `10:00:00.000 [Client INFO] ${m}`;
test("bridge-health reads a bad log line after the last connected line as a failure", () => {
  assert.equal(logVerdict([line("Connected to WhatsApp!")].join("\n")).verdict, "pass");
  assert.equal(logVerdict([line("Connected to WhatsApp!"), line("logged out by the phone")].join("\n")).verdict, "fail");
  assert.equal(logVerdict([line("logged out"), line("Connected to WhatsApp!"), line("ping")].join("\n")).verdict, "pass");
  assert.equal(logVerdict("nothing here").verdict, "unknown");
  assert.equal(combine([{ verdict: "pass", reasons: [] }, { verdict: "unknown", reasons: ["x"] }, { verdict: "fail", reasons: ["y"] }]).verdict, "fail");
  assert.equal(combine([{ verdict: "pass", reasons: [] }, { verdict: "unknown", reasons: ["x"] }]).verdict, "unknown");
});

test("bridge-health exits 0, 1 or 2 for pass, fail and unknown", async () => {
  const s = scratch(), b = await bridge(), log = join(s.home, "bridge.log");
  try {
    writeFileSync(s.config, JSON.stringify({ allowlist: join(s.home, "allow.json"), bridgeUrl: b.url, bridgeLog: log }));
    writeFileSync(log, `${line("Connected to WhatsApp!")}\n`);
    const pass = await node(s, "bridge-health.ts");
    assert.equal(pass.code, 0);
    assert.ok(pass.stdout.startsWith("whatsapp-bridge: pass"), pass.stdout);
    writeFileSync(log, `${line("Connected to WhatsApp!")}\n${line("logged out")}\n`);
    assert.equal((await node(s, "bridge-health.ts")).code, 1);
    writeFileSync(log, "no connected line\n");
    assert.equal((await node(s, "bridge-health.ts")).code, 2);
  } finally { b.server.close(); }
  const closed = scratch(); // a refused connection is a failure, whatever the log says
  const gone = await bridge();
  gone.server.close();
  writeFileSync(join(closed.home, "bridge.log"), `${line("Connected to WhatsApp!")}\n`);
  writeFileSync(closed.config, JSON.stringify({ allowlist: join(closed.home, "allow.json"), bridgeUrl: gone.url, bridgeLog: join(closed.home, "bridge.log") }));
  const down = await node(closed, "bridge-health.ts");
  assert.equal(down.code, 1, down.stdout + down.stderr);
});

function store(s: Scratch): string {
  const path = join(s.home, "messages.db");
  const db = new DatabaseSync(path);
  db.exec("create table chats (jid text, name text); create table messages (chat_jid text, sender text, timestamp text, is_from_me integer, content text, media_type text)");
  db.exec("insert into chats values ('15550100@s.whatsapp.net', 'Pat Example')");
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  db.exec(`insert into messages values ('15550100@s.whatsapp.net', 'pat', '${at(20)}', 0, 'hello from pat', null), ('15550100@s.whatsapp.net', 'me', '${at(10)}', 1, 'hello from me', null)`);
  db.close();
  return path;
}
test("whatsapp-recent lists inbound messages, adds outbound with --all, and caps with TRUNCATED and no output", async () => {
  const s = scratch(), b = await bridge();
  try {
    writeFileSync(s.config, JSON.stringify({ allowlist: join(s.home, "allow.json"), bridgeUrl: b.url, messagesDb: store(s) }));
    const inbound = await node(s, "whatsapp-recent.ts");
    assert.equal(inbound.code, 0, inbound.stderr);
    assert.ok(inbound.stdout.includes("<- Pat Example: hello from pat") && !inbound.stdout.includes("hello from me"), inbound.stdout);
    const all = await node(s, "whatsapp-recent.ts", ["--all"]);
    assert.ok(all.stdout.includes("-> Pat Example: hello from me"), all.stdout);
    const capped = await node(s, "whatsapp-recent.ts", ["--all", "--limit", "1"]);
    assert.equal(capped.code, 2);
    assert.ok(capped.stderr.startsWith("TRUNCATED - ") && capped.stdout === "", capped.stderr);
  } finally { b.server.close(); }
});
test("whatsapp-recent exits 2 with CANNOT READ when the bridge does not answer", async () => {
  const s = scratch();
  writeFileSync(s.config, JSON.stringify({ allowlist: join(s.home, "allow.json"), bridgeUrl: `http://127.0.0.1:${CLOSED_PORT}/api`, messagesDb: store(s) }));
  const r = await node(s, "whatsapp-recent.ts");
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith("CANNOT READ - ") && r.stdout === "", r.stderr);
});

test("install does not write through a dangling symlink at the config path", async () => {
  const s = scratch(), fresh = join(s.home, "fresh"), target = join(s.home, "elsewhere-config.json");
  mkdirSync(join(fresh, ".config", "whatsapp-gate"), { recursive: true });
  symlinkSync(target, join(fresh, ".config", "whatsapp-gate", "config.json"));
  const r = await node({ ...s, home: fresh }, "install.ts", ["--skip-bridge-check"]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("config: kept") && !existsSync(target), r.stdout);
});
test("install does not write through a dangling symlink at the allowlist path", async () => {
  const s = scratch(), target = join(s.home, "elsewhere-allow.json"), link = join(s.home, "allow-link.json");
  symlinkSync(target, link);
  writeFileSync(s.config, JSON.stringify({ allowlist: link, outbox: s.outbox }));
  const r = await node(s, "install.ts", ["--skip-bridge-check"]);
  assert.ok(r.stdout.includes("allowlist: kept") && !existsSync(target), r.stdout + r.stderr);
});

// A bridge that answers every request with a redirect to a second server, which counts what reaches it.
async function redirecting(): Promise<{ url: string; reached: () => number; close: () => void }> {
  let reached = 0;
  const target = createServer((_, res) => { reached++; res.statusCode = 404; res.end(); });
  await new Promise<void>((ok) => target.listen(0, "127.0.0.1", ok));
  const to = `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/send`;
  const front = createServer((_, res) => { res.statusCode = 307; res.setHeader("Location", to); res.end(); });
  await new Promise<void>((ok) => front.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(front.address() as AddressInfo).port}/api`, reached: () => reached, close: () => { front.close(); target.close(); } };
}
async function redirectScratch(url: string): Promise<{ s: Scratch; msg: string }> {
  const s = scratch(), msg = join(s.home, "m.txt");
  writeFileSync(msg, "hello\n");
  writeFileSync(join(s.home, "token"), "t\n");
  writeFileSync(join(s.home, "bridge.log"), `${line("Connected to WhatsApp!")}\n`);
  writeFileSync(s.config, JSON.stringify({
    allowlist: join(s.home, "allow.json"), bridgeUrl: url, tokenFile: join(s.home, "token"), outbox: s.outbox, logDir: s.logDir,
    messagesDb: store(s), bridgeLog: join(s.home, "bridge.log"),
  }));
  return { s, msg };
}
test("the sender does not follow a redirect from the bridge", async () => {
  const r = await redirecting();
  try {
    const { s, msg } = await redirectScratch(r.url);
    const out = await node(s, "whatsapp-send.ts", ["--to", "pat", "--text-file", msg, "--sha256", sha("hello")]);
    assert.ok(out.stderr.includes("The outcome is UNKNOWN") && r.reached() === 0, `${out.stderr} reached=${r.reached()}`);
  } finally { r.close(); }
});
for (const [name, args, code, said] of [["bridge-health.ts", [], 2, "inconclusive (redirect refused)"], ["whatsapp-recent.ts", [], 2, "CANNOT READ"], ["install.ts", [], 3, "NO ANSWER"]] as const) {
  test(`${name} does not follow a redirect from the bridge`, async () => {
    const r = await redirecting();
    try {
      const { s } = await redirectScratch(r.url);
      const out = await node(s, name, [...args]);
      assert.equal(out.code, code, out.stdout + out.stderr);
      assert.ok((out.stdout + out.stderr).includes(said), out.stdout + out.stderr);
      assert.equal(r.reached(), 0);
    } finally { r.close(); }
  });
}
