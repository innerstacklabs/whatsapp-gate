// The config file's validation.
import assert from "node:assert/strict";
import test from "node:test";
import { defaults, parseConfig } from "../lib/config.ts";

const bad = (raw: unknown, why: string) => assert.throws(() => parseConfig(raw, "cfg"), (e: Error) => e.message.includes(why), why);

test("an empty config takes every default and sets no policy", () => {
  assert.deepEqual(parseConfig({}, "cfg"), { ...defaults(), sender: null, presence: null });
});
test("every field can be set", () => {
  const c = parseConfig({ allowlist: "/a/allow.json", bridgeUrl: "http://localhost:9000/api/", sender: { env: "AGENT", value: "x" }, presence: ["/bin/true", "-q"] }, "cfg");
  assert.equal(c.allowlist, "/a/allow.json");
  assert.equal(c.bridgeUrl, "http://localhost:9000/api");
  assert.deepEqual(c.sender, { env: "AGENT", value: "x" });
  assert.deepEqual(c.presence, ["/bin/true", "-q"]);
});
test("a misspelled field is an error, not a missing policy", () => bad({ presense: ["/bin/false"] }, "unknown field"));
test("a config that is not an object is an error", () => { bad([], "must be a JSON object"); bad("x", "must be a JSON object"); });
test("a relative path is an error", () => bad({ allowlist: "allow.json" }, "absolute path"));
test("a path that is not normalized is an error", () => bad({ outbox: "/a/../b" }, "normalized"));
test("a bridge URL that is not on this machine is an error", () => { bad({ bridgeUrl: "http://example.com/api" }, "bridgeUrl"); bad({ bridgeUrl: "https://127.0.0.1/api" }, "bridgeUrl"); });
test("a bridge URL whose path is not /api is an error", () => bad({ bridgeUrl: "http://127.0.0.1:8790/other" }, "must end in /api"));
test("a bridge URL with a query string, a fragment or a user name and password is an error", () => {
  for (const u of ["http://127.0.0.1/api?x=1", "http://127.0.0.1/api?", "http://127.0.0.1/api#x", "http://user:pw@127.0.0.1/api", "http://user@127.0.0.1/api"]) {
    bad({ bridgeUrl: u }, "bridgeUrl may not hold");
  }
});
test("a bridge URL must name a port of 1024 or higher, and says why", () => {
  for (const u of ["http://127.0.0.1/api", "http://127.0.0.1:80/api", "http://127.0.0.1:1/api", "http://127.0.0.1:1023/api"]) {
    bad({ bridgeUrl: u }, "port of 1024 or higher");
  }
  assert.equal(parseConfig({ bridgeUrl: "http://127.0.0.1:1024/api" }, "cfg").bridgeUrl, "http://127.0.0.1:1024/api");
});
test("a sender with a missing, extra or empty part is an error", () => {
  bad({ sender: { env: "A" } }, "sender"); bad({ sender: { env: "A", value: "" } }, "sender");
  bad({ sender: { env: "A", value: "x", more: 1 } }, "sender"); bad({ sender: { env: "1A", value: "x" } }, "sender");
});
test("a presence command that is empty, not an array or not an absolute path is an error", () => {
  bad({ presence: [] }, "presence"); bad({ presence: "/bin/true" }, "presence"); bad({ presence: ["true"] }, "presence");
});
