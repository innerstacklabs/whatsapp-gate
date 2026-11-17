// The sender, run for real with no bridge, no token and no override: the bridge URL is a closed port and the token
// file does not exist, so a send that passes every check stops at "cannot read the bridge token" before any request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SENDER_PATH } from "../lib/whatsapp.ts";
import { PAT, cp, envFor, scratch, sha, type Scratch } from "./helpers.ts";

function run(s: Scratch, args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [SENDER_PATH, ...args], { env: envFor(s), encoding: "utf8", timeout: 20_000 });
  return { status: r.status, stderr: r.stderr };
}
const fixtures = (s: Scratch) => {
  const msg = join(s.home, "msg.txt"), att = join(s.home, "clip.mp4");
  writeFileSync(msg, "hello\n");
  writeFileSync(att, "bytes");
  return { msg, att, text: ["--to", "pat", "--text-file", msg, "--sha256", sha("hello")] };
};
const refused = (r: { status: number | null; stderr: string }, why: string) => { assert.equal(r.status, 1, r.stderr); assert.ok(r.stderr.includes(why), r.stderr); };

test("a valid send with a file stages its copy, stops before any request, and leaves the outbox empty", () => {
  const s = scratch(), f = fixtures(s);
  refused(run(s, [...f.text, "--attach", f.att, "--attach-sha256", sha("bytes")]), "cannot read the bridge token");
  assert.ok(existsSync(s.outbox), "the sender never reached the staging step");
  assert.deepEqual(readdirSync(s.outbox), []);
});
test("a valid text-only send stops at the token, and creates no outbox", () => {
  const s = scratch();
  refused(run(s, fixtures(s).text), "cannot read the bridge token");
  assert.ok(!existsSync(s.outbox));
});
test("a request the bridge does not answer is logged as an unknown outcome, and the refusal says so", () => {
  const s = scratch(), f = fixtures(s);
  writeFileSync(join(s.home, "no-token"), "test-token\n"); // the bridge URL is a closed port, so nothing is received
  refused(run(s, f.text), "The outcome is UNKNOWN");
  const row = JSON.parse(readFileSync(join(s.logDir, "whatsapp-sends.jsonl"), "utf8").trim());
  assert.equal(row.success, null);
  assert.equal(row.sha256, sha("hello"));
  assert.ok(String(row.bridge).startsWith("no answer"), JSON.stringify(row));
});
test("the sender reads the one config file, whatever WHATSAPP_GATE_CONFIG says", () => {
  const s = scratch(), f = fixtures(s);
  const loose = scratch({}, { pat: PAT, eve: { jid: "15550111@s.whatsapp.net", name: "Eve Example" } });
  const args = ["--to", "eve", "--text-file", f.msg, "--sha256", sha("hello")];
  const r = spawnSync(process.execPath, [SENDER_PATH, ...args], { env: { ...envFor(s), WHATSAPP_GATE_CONFIG: loose.config }, encoding: "utf8", timeout: 20_000 });
  refused(r, "not in the allowlist");
  assert.ok(!existsSync(s.outbox) && !existsSync(s.logDir));
});
test("a text whose hash differs from the approved one is refused", () => {
  const s = scratch(), f = fixtures(s);
  refused(run(s, ["--to", "pat", "--text-file", f.msg, "--sha256", sha("other")]), "sha256 mismatch");
});
test("an attachment whose hash differs from the approved one is refused before it is staged", () => {
  const s = scratch(), f = fixtures(s);
  refused(run(s, [...f.text, "--attach", f.att, "--attach-sha256", sha("other")]), "the attachment changed");
  assert.ok(!existsSync(s.outbox));
});
test("arguments that are not the canonical shape exit 2 with the usage line", () => {
  const s = scratch(), f = fixtures(s);
  for (const args of [[], f.text.slice(0, 4), [...f.text, "--attach", f.att], [...f.text, "--attach", f.att, "--attach-sha256"], ["--text-file", f.msg, "--to", "pat", "--sha256", sha("hello")]]) {
    const r = run(s, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.ok(r.stderr.includes("usage:"));
  }
});
test("a name that is not in the allowlist is refused", () => {
  const s = scratch(), f = fixtures(s);
  refused(run(s, ["--to", "nobody", ...f.text.slice(2)]), "not in the allowlist");
});
test("an allowlist entry with a bad jid refuses every send", () => {
  const s = scratch({}, { pat: { ...PAT, jid: "pat@example.com" } });
  refused(run(s, fixtures(s).text), "cannot read the allowlist");
});
test("a text with a character outside the allowed set is refused", () => {
  const s = scratch(), f = fixtures(s), body = `hel${cp(0x200d)}lo`;
  writeFileSync(f.msg, body);
  refused(run(s, ["--to", "pat", "--text-file", f.msg, "--sha256", sha(body)]), "outside the allowed set");
});
test("a presence command that does not exit 0 refuses the send", () => {
  const s = scratch({ presence: ["/bin/false"] });
  refused(run(s, fixtures(s).text), "presence command");
});
test("a send with the presence command exiting 0 goes on to the token", () => {
  const s = scratch({ presence: ["/bin/true"] });
  refused(run(s, fixtures(s).text), "cannot read the bridge token");
});
