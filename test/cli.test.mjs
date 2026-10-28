import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CLI, fixture, readJson } from "./helpers.mjs";

test("help, version, and argument validation work", (t) => {
  const f = fixture(t);
  const help = f.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /inspect\|diff\|doctor\|update/);
  const version = f.run(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const unknown = f.run(["unknown"]);
  assert.equal(unknown.status, 2);
  const invalid = f.run(["diff", "--dry-run"]);
  assert.equal(invalid.status, 2);
  assert.ok(fs.existsSync(CLI));
});

test("inspect emits structured data without writing state", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const result = f.run(["inspect", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.data.pi.host.version, "1.4.0");
  assert.equal(payload.data.herdr.integration, "current");
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  assert.deepEqual(f.commands(), ["herdr --version", "herdr integration status", "herdr plugin list --json"]);
});

test("diff reports drift but never repairs it", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const result = f.run(["diff", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.differences.some((item) => item.kind === "dependency-spec"));
  assert.ok(payload.differences.some((item) => item.kind === "host-link"));
  assert.equal(payload.changes, "none");
  assert.equal(fs.existsSync(path.join(f.npmDir, "host-link")), false);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
});

test("update dry-run prints a native plan with no side effects", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const result = f.run(["update", "--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.nativeMode, true);
  assert.ok(payload.steps.every((step) => step.status === "planned" || step.status === "skipped"));
  assert.equal(payload.changes, "none");
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(fs.existsSync(path.join(f.npmDir, "host-link")), false);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  assert.deepEqual(f.commands(), ["herdr --version", "herdr integration status", "herdr plugin list --json"]);
});

test("doctor does not execute selftest by default", (t) => {
  const f = fixture(t);
  const result = f.run(["doctor", "--json"]);
  assert.equal(result.status, 4);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.checks.some((check) => check.resource === "pi.runtime-load" && check.status === "warn"));
  assert.equal(f.commands().some((command) => command.includes("selftest")), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});
