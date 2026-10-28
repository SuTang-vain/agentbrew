import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers.mjs";

test("an unavailable herdr is explicitly skipped", (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  const result = f.run(["update", "--json"], { MOCK_HERDR_MISSING: "1" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const herdr = payload.steps.find((step) => step.id === "herdr-integration");
  assert.equal(herdr.status, "skipped");
  assert.match(herdr.message, /not available/);
});

test("a failed herdr integration is partial and does not run selftest", (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  const result = f.run(["update", "--selftest", "--json"], { MOCK_HERDR_FAIL: "1" });
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.steps.at(-1).id, "herdr-integration");
  assert.equal(payload.steps.at(-1).status, "failed");
  assert.equal(f.commands().some((command) => command.includes("selftest")), false);
});

test("doctor accepts a current integration after update", (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  assert.equal(f.run(["update"]).status, 0);
  const result = f.run(["doctor", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.checks.some((check) => check.resource === "herdr.pi-integration" && check.status === "pass"));
});

test("a malformed plugin list is a warning rather than a false integration failure", (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  assert.equal(f.run(["update"]).status, 0);
  const result = f.run(["doctor", "--json"], { MOCK_HERDR_BAD_JSON: "1" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.checks.some((check) => check.resource === "herdr.plugins" && check.status === "warn"));
});

test("an outdated integration produces a diff without rebuilding it", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.herdrStatus, "outdated");
  const result = f.run(["diff", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.differences.some((difference) => difference.resource === "herdr.pi-integration" && difference.actual === "outdated"));
  assert.equal(fs.existsSync(path.join(f.agentDir, "extensions", "herdr-agent-state.ts")), false);
});
