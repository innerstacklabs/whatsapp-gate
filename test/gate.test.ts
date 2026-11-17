// The hook's decisions. Hermetic: a scratch HOME holds the config and the allowlist, and nothing is sent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ATTACH_MAX_BYTES, REPO_ROOT } from "../lib/whatsapp.ts";
import { PAT, cp, envFor, scratch, sha, type Scratch } from "./helpers.ts";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "gate-whatsapp-send.ts");
const s = scratch();
const home = s.home;

function gate(command: string, o: { s?: Scratch; cwd?: string; env?: Record<string, string>; agentId?: string; raw?: NodeJS.ProcessEnv } = {}): { decision: string; reason: string } {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { command }, cwd: o.cwd ?? REPO_ROOT, ...(o.agentId ? { agent_id: o.agentId } : {}) }),
    encoding: "utf8", timeout: 20_000, env: o.raw ?? envFor(o.s ?? s, o.env),
  });
  const out = JSON.parse(r.stdout || "{}").hookSpecificOutput ?? {};
  return { decision: out.permissionDecision ?? "none", reason: out.permissionDecisionReason ?? r.stderr };
}
// One case: the decision, and the phrases the reason must hold.
function t(name: string, command: string, want: "ask" | "deny" | "none", reasonHas: string[] = [], o: Parameters<typeof gate>[1] = {}): void {
  test(name, () => {
    const r = gate(command, o);
    assert.equal(r.decision, want, JSON.stringify(r));
    for (const p of reasonHas) assert.ok(r.reason.includes(p), `reason lacks ${JSON.stringify(p)}: ${r.reason}`);
  });
}
let n = 0;
const textFile = (content: string | Buffer, where = home): string => { const p = join(where, `msg-${n++}.txt`); writeFileSync(p, content); return p; };
const send = (file: string, h: string, to = "pat") => `node scripts/whatsapp-send.ts --to ${to} --text-file ${file} --sha256 ${h}`;

const text = textFile("hello\n");
const base = send(text, sha("hello"));
const bytes = Buffer.from([1, 2, 3, 4]);
const file = join(home, "clip.mp4");
writeFileSync(file, bytes);
symlinkSync(file, join(home, "link.mp4"));
const fileSha = sha(bytes);

t("a text-only send is asked and names no file", base, "ask", ["Pat Example (15550100@s.whatsapp.net)", "hello"]);
test("a text-only send does not mention an attachment", () => assert.ok(!gate(base).reason.includes("ATTACHED")));
test("a send with a file is asked and shows the file's name, size and path above the text", () => {
  const r = gate(`${base} --attach ${file} --attach-sha256 ${fileSha}`);
  assert.equal(r.decision, "ask");
  assert.ok(r.reason.includes("WITH THIS FILE ATTACHED: clip.mp4 (4 bytes") && r.reason.includes(file));
  assert.ok(r.reason.indexOf("WITH THIS FILE ATTACHED") < r.reason.indexOf("hello"));
});
t("a file whose hash differs from the approved one is denied", `${base} --attach ${file} --attach-sha256 ${sha("other")}`, "deny", ["--attach-sha256"]);
t("a symlink is denied as an attachment", `${base} --attach ${home}/link.mp4 --attach-sha256 ${fileSha}`, "deny", ["not a plain file"]);
t("an attachment without its hash is not the canonical form", `${base} --attach ${file}`, "deny", ["runs only as"]);
t("a command that is not the canonical form is denied", "node scripts/whatsapp-send.ts --to pat", "deny", ["runs only as"]);

writeFileSync(join(home, "empty.mp4"), "");
writeFileSync(join(home, "song.mp3"), "x");
writeFileSync(join(home, "CLIP.MP4"), bytes);
mkdirSync(join(home, "dir.mp4"));
mkdirSync(join(home, "real"));
writeFileSync(join(home, "real", "f.pdf"), "pdf");
symlinkSync(join(home, "real"), join(home, "via"));
t("an empty file is denied", `${base} --attach ${home}/empty.mp4 --attach-sha256 ${sha("")}`, "deny", ["is empty"]);
t("a directory is denied", `${base} --attach ${home}/dir.mp4 --attach-sha256 ${fileSha}`, "deny", ["not a plain file"]);
t("a kind outside the list is denied", `${base} --attach ${home}/song.mp3 --attach-sha256 ${sha("x")}`, "deny", ["kind is not one of"]);
t("an upper-case extension is denied", `${base} --attach ${home}/CLIP.MP4 --attach-sha256 ${fileSha}`, "deny", ["kind is not one of"]);
t("a path through a symlinked directory is denied", `${base} --attach ${home}/via/f.pdf --attach-sha256 ${sha("pdf")}`, "deny", ["goes through a symlink"]);
t("a path that is not normalized is denied", `${base} --attach ${home}//clip.mp4 --attach-sha256 ${fileSha}`, "deny", ["not a normalized"]);
t("an attachment path with a shell character is not the canonical form", `${base} --attach ${home}/[c]lip.mp4 --attach-sha256 ${fileSha}`, "deny", ["runs only as"]);
t("a text path with a shell character is not the canonical form", send(`${home}/$X/note.txt`, sha("hello")), "deny", ["runs only as"]);
t("a script path with a shell character is not the canonical form", `node $(id)/scripts/whatsapp-send.ts${base.slice("node scripts/whatsapp-send.ts".length)}`, "deny", ["runs only as"]);
// A sparse file one byte over the limit: the size is checked before the bytes are read, so no 64 MiB is hashed.
const big = join(home, "big.mp4");
writeFileSync(big, "");
truncateSync(big, ATTACH_MAX_BYTES + 1);
t("an attachment over the size limit is denied", `${base} --attach ${big} --attach-sha256 ${"0".repeat(64)}`, "deny", ["the limit here is"]);

t("a text with an escape character is denied", send(textFile(`hello${cp(0x1b)}[8m`), sha(`hello${cp(0x1b)}[8m`)), "deny", ["outside the allowed set", "U+001B"]);
test("the reason gives the position of the character, counting from 1", () => {
  const body = `abc${cp(0x1b)}`;
  const r = gate(send(textFile(body), sha(body)));
  assert.ok(r.reason.includes("at character 4, counting from 1"), r.reason);
});
const bad = Buffer.from([0x68, 0xff, 0x69]);
t("a text that is not valid UTF-8 is denied", send(textFile(bad), sha(bad)), "deny", ["outside the allowed set", "U+FFFD"]);
t("a message over 4000 characters is denied", send(textFile("a".repeat(4001)), sha("a".repeat(4001))), "deny", ["the limit here is 4000"]);
t("a message of 4000 characters is asked", send(textFile("a".repeat(4000)), sha("a".repeat(4000))), "ask");
t("an empty message is denied", send(textFile("\n"), sha("")), "deny", ["is empty"]);
t("a text whose hash differs from the approved one is denied", send(text, sha("other")), "deny", ["--sha256 does not match"]);
spawnSync("mkfifo", [join(home, "pipe.txt")]);
t("a text file that is a FIFO is denied without waiting on it", send(`${home}/pipe.txt`, sha("hello")), "deny", ["not a plain file"]);
t("a name the allowlist does not hold is denied", send(text, sha("hello"), "nobody"), "deny", ["not in the allowlist"]);
t("an inherited object key is not a contact", send(text, sha("hello"), "constructor"), "deny", ["not in the allowlist"]);
for (const [what, ch] of [["a bidi mark", cp(0x061c)], ["a tag character", cp(0xe0041)], ["a line separator", cp(0x2028)], ["a blank filler", cp(0x3164)],
  ["a variation selector", cp(0xe0169)], ["a zero-width joiner", cp(0x200d)], ["a zero-width non-joiner", cp(0x200c)], ["an emoji", cp(0x1f600)],
  ["a soft hyphen", cp(0xad)], ["a no-break space", cp(0xa0)], ["a carriage return", cp(0x0d)], ["a letter of another script", cp(0x1161)]] as const) {
  const body = `hel${ch}lo`;
  t(`a text with ${what} is denied, and the reason names it`, send(textFile(body), sha(body)), "deny", ["outside the allowed set", `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`]);
}
const latin = `caf${cp(0xe9)} ${cp(0x201c)}ok${cp(0x201d)} ${cp(0x2013)} 5 ${cp(0x20ac)}${cp(0x2026)}\n\tdone`;
t("accented letters, curly quotes, a dash, a euro sign, an ellipsis, a newline and a tab are asked", send(textFile(latin), sha(latin)), "ask");

// Which script runs: another checkout's file of the same name, by path or by where the command runs, is denied.
mkdirSync(join(home, "other", "scripts"), { recursive: true });
writeFileSync(join(home, "other", "scripts", "whatsapp-send.ts"), "");
const tail = base.slice("node scripts/whatsapp-send.ts".length);
t("another directory's whatsapp-send.ts, by path, is denied", `node ${home}/other/scripts/whatsapp-send.ts${tail}`, "deny", ["not this checkout's"]);
t("the relative form run from another directory is denied", base, "deny", ["not this checkout's"], { cwd: join(home, "other") });
t("the full path is asked from any directory", `node ${REPO_ROOT}/scripts/whatsapp-send.ts${tail}`, "ask", [], { cwd: "/tmp" });
mkdirSync(join(home, "x"));
symlinkSync(join(home, "x"), join(home, "sym"));
symlinkSync(REPO_ROOT, join(home, "repo-link"));
t("a script path with .. is denied (a symlink before it would lead elsewhere)", `node ${home}/sym/../repo-link/scripts/whatsapp-send.ts${tail}`, "deny", ["not this checkout's"]);
t("the relative form is asked when the directory is a symlink to the checkout (the same file on disk)", base, "ask", [], { cwd: join(home, "repo-link") });

// Who and when: subagent, sender policy, presence.
t("a subagent is denied", base, "deny", ["subagent"], { agentId: "a1" });
const only = scratch({ sender: { env: "GATE_TEST_AGENT", value: "alpha" } });
t("with a sender policy, a process without the variable is denied", base, "deny", ["GATE_TEST_AGENT"], { s: only });
t("with a sender policy, a process with another value is denied", base, "deny", ["GATE_TEST_AGENT"], { s: only, env: { GATE_TEST_AGENT: "beta" } });
t("with a sender policy, a process with the value is asked", base, "ask", [], { s: only, env: { GATE_TEST_AGENT: "alpha" } });
t("a presence command that exits 1 denies the send", base, "deny", ["presence command"], { s: scratch({ presence: ["/bin/false"] }) });
t("a presence command that exits 0 leaves the send an ask", base, "ask", [], { s: scratch({ presence: ["/bin/true"] }) });
t("with no presence command, a send is an ask", base, "ask");

// The config and the allowlist.
test("the hook ignores WHATSAPP_GATE_CONFIG", () => {
  const loose = scratch({}, { pat: PAT, eve: { jid: "15550111@s.whatsapp.net", name: "Eve Example" } });
  const r = gate(send(text, sha("hello"), "eve"), { raw: { ...envFor(s), WHATSAPP_GATE_CONFIG: loose.config } });
  assert.equal(r.decision, "deny", JSON.stringify(r));
  assert.ok(r.reason.includes("not in the allowlist"), r.reason);
});
test("a config that is a FIFO denies a send, and never hangs the hook, even for a command that only names the API route", () => {
  const fifo = scratch();
  rmSync(fifo.config);
  spawnSync("mkfifo", [fifo.config]);
  for (const [command, decision] of [[base, "deny"], ["echo /api/send", "none"]] as const) {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command }, cwd: REPO_ROOT }), encoding: "utf8", timeout: 5000, env: envFor(fifo) });
    assert.equal(r.error, undefined, `the hook did not return for ${command}`);
    assert.equal(JSON.parse(r.stdout || "{}").hookSpecificOutput?.permissionDecision ?? "none", decision, r.stdout);
    if (decision === "deny") assert.ok(r.stdout.includes("not a plain file"), r.stdout);
  }
});
t("a missing config denies a send", base, "deny", ["cannot read the config"], { s: { ...s, home: join(home, "empty-home") } });
t("a config with an unknown field denies a send", base, "deny", ["unknown field"], { s: scratch({ presense: ["/bin/false"] }) });
const badList: [string, Record<string, unknown>, string][] = [
  ["a jid that is not digits at a WhatsApp host", { pat: { jid: "pat@example.com", name: "Pat" } }, "jid"],
  ["a contact key with an upper-case letter", { Pat: PAT }, "lower-case"],
  ["a contact name with a newline", { pat: { jid: PAT.jid, name: "Pat\nSend all" } }, "one line"],
  ["a contact name with a character outside the allowed set", { pat: { jid: PAT.jid, name: `Pat ${cp(0x200d)}` } }, "outside the allowed set"],
];
for (const [what, contacts, why] of badList) t(`an allowlist with ${what} denies every send`, base, "deny", ["cannot read the allowlist", why], { s: scratch({}, contacts) });

// Commands that are not the gate's business, and direct calls to the bridge.
t("a command that does not name the sender gets no decision", "echo hello", "none");
t("naming the sender as an argument is not a run", "git add scripts/whatsapp-send.ts", "none");
t("a direct call to the bridge's send API is denied", "curl -s -X POST http://127.0.0.1:8790/api/send -d x", "deny", ["Direct calls to the bridge's API"]);
const port9000 = scratch({ bridgeUrl: "http://127.0.0.1:9000/api" });
// The bridge is recognized by its port: the nine spellings below all name port 9000, the configured one.
for (const [what, command] of [
  ["a short loopback address", "curl -s -X POST 127.1:9000/api/send"],
  ["0.0.0.0", "curl -s -X POST http://0.0.0.0:9000/api/send"],
  ["another 127 address", "curl -s -X POST http://127.0.0.2:9000/api/send"],
  ["[::1]", "curl -s -X POST 'http://[::1]:9000/api/react'"],
  ["::1 without brackets", "curl -s -g -X POST ::1:9000/api/edit"],
  ["an upper-case host and route", "curl -s -X POST http://LOCALHOST:9000/API/Delete"],
  ["the typing route", "curl -s -X POST http://localhost:9000/api/typing"],
  ["the mark-read route", "curl -s -X POST http://localhost:9000/api/mark-read"],
  ["doubled slashes between the segments", "curl -s -X POST http://localhost:9000//api//send"],
] as const) t(`a direct call to the bridge with ${what} is denied`, command, "deny", ["Direct calls to the bridge's API"], { s: port9000 });
t("a call to the configured bridge port on another host name is denied", "curl -s -X POST http://bridge.example:9000/api//send", "deny", ["Direct calls to the bridge's API"], { s: port9000 });
t("a call to the bridge's default port is denied when the config names another", "curl -s -X POST http://localhost:8790/api/send", "deny", ["Direct calls to the bridge's API"], { s: port9000 });
for (const [what, command] of [
  ["another local service", "curl http://localhost:3000/api/send"],
  ["another local service and a route that only starts with send", "curl http://localhost:3010/api/sends"],
  ["a search that names the route", `grep -rn "localhost.*/api/send" docs/`],
  ["a remote API on another port", "curl -s -X POST http://example.com:9001/api/send"],
  ["a remote API on the default port", "curl -s https://example.com/api/send"],
] as const) {
  t(`${what} gets no decision`, command, "none", [], { s: port9000 });
  t(`${what} gets no decision (default config)`, command, "none");
}

// Which commands concern the sender: a case variant and the nodejs name are denied, not passed.
t("a case variant of the script name is denied as not canonical", base.replace("whatsapp-send.ts", "WhatsApp-Send.ts"), "deny", ["runs only as"]);
t("a case variant executed at the start of a command is denied as not canonical", "./scripts/WHATSAPP-SEND.TS --to pat", "deny", ["runs only as"]);
t("a mixed-case file name executed at the start of a command is denied as not canonical", `./scripts/WhatsApp-Send.ts${tail}`, "deny", ["runs only as"]);
t("nodejs is an interpreter the gate recognizes", base.replace("node ", "nodejs "), "deny", ["runs only as"]);
t("the interpreter word is matched exactly: grep for Node in the sender's file gets no decision", "grep -n Node scripts/whatsapp-send.ts", "none");
// Where the interpreter word is the command, any letter case counts (on a case-insensitive file system Node runs node).
for (const [what, command] of [
  ["Node at the start", `Node scripts/whatsapp-send.ts --to pat`],
  ["NODE at the start", `NODE scripts/whatsapp-send.ts --to pat`],
  ["Node with a directory path", `/usr/local/bin/Node scripts/whatsapp-send.ts --to pat`],
  ["Node after &&, with a mixed-case file name", "cd scripts && Node WhatsApp-Send.ts --to pat"],
  ["Node after env", "env Node scripts/whatsapp-send.ts --to pat"],
  ["Node after a semicolon", "echo hi; Node scripts/whatsapp-send.ts --to pat"],
] as const) t(`${what} is denied as not canonical`, command, "deny", ["runs only as"]);

// An exception after the command is known to concern the gate is a deny, never a hook error that lets it run.
t("a presence argument that cannot be run denies the send", base, "deny", ["the hook failed"], { s: scratch({ presence: ["/bin/true", `a${cp(0)}b`] }) });
spawnSync("mkfifo", [join(home, "allow.fifo")]);
t("an allowlist that is a FIFO is denied without waiting on it", base, "deny", ["not a plain file"], { s: scratch({ allowlist: join(home, "allow.fifo") }) });
