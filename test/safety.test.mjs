import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, readJson } from "./helpers.mjs";
import { formatCommand, redact } from "../dist/process.js";

test("common credentials are redacted from commands and process failures", async (t) => {
  const f = fixture(t);
  const secret = "secret-test-value-123";
  assert.equal(redact(`token=${secret}`), "token=[redacted]");
  assert.equal(redact(`https://alice:${secret}@example.com/private`), "https://[redacted]@example.com/private");
  assert.equal(formatCommand("cmd", ["normal argument", "x; echo unsafe"]), 'cmd "normal argument" "x; echo unsafe"');

  const result = f.run(["update", "--json"], { MOCK_PI_FAIL: "1", MOCK_SECRET: secret });
  assert.equal(result.status, 3);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(readJson(path.join(f.stateDir, "last-result.json")).steps.at(-1).message.includes(secret), false);
});

test("unsafe host dependency names are rejected before execution", (t) => {
  const f = fixture(t);
  const manifestPath = path.join(f.npmDir, "package.json");
  const manifest = readJson(manifestPath);
  manifest.dependencies["@earendil-works/pi-../escape"] = "1.0.0";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = f.run(["update"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsafe host dependency name/);
  assert.deepEqual(f.commands(), []);
});

test("a selftest failure is not reported as a healthy update", (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  const result = f.run(["update", "--selftest", "--json"], { MOCK_SELFTEST_FAIL: "1" });
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.steps.at(-1).id, "selftest");
  assert.equal(payload.steps.at(-1).status, "failed");
  assert.equal(payload.status, "partial");
});
