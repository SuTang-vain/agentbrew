import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";

test("update advances the host, repairs portable links, and records state", (t) => {
  const f = fixture(t);
  const nextDir = f.setHost("1.5.0");
  const result = f.run(["update", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "success");
  assert.equal(fs.realpathSync(path.join(f.npmDir, "host-link")), fs.realpathSync(nextDir));
  const manifest = readJson(path.join(f.npmDir, "package.json"));
  assert.equal(manifest.dependencies[HOST_PACKAGE], "file:host-link");
  assert.equal(manifest.dependencies["pi-subagents"], "^0.83.0");
  for (const peer of PEERS) {
    const base = path.basename(peer);
    assert.equal(manifest.dependencies[peer], `file:host-deps/${base}`);
    assert.equal(fs.realpathSync(path.join(f.npmDir, "host-deps", base)), fs.realpathSync(path.join(f.npmDir, "node_modules", peer)));
  }
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "herdr-agent-state.ts"), "utf8"), "generated\n");
  const commands = f.commands();
  assert.deepEqual(commands.slice(0, 3), ["pi update --all", "npm install --legacy-peer-deps", "herdr --version"]);
  assert.equal(commands.some((command) => command.includes("selftest")), false);
  assert.equal(commands.at(-1), "herdr plugin list --json");
  assert.equal(readJson(path.join(f.stateDir, "last-result.json")).status, "success");
  assert.equal(readJson(path.join(f.stateDir, "last-snapshot.json")).host.version, "1.4.0");
});

test("selftest runs only when explicitly enabled", (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  const result = f.run(["update", "--selftest", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.commands().filter((command) => command === "npm run selftest").length, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.some((check) => check.resource === "pi.runtime-load"), false);
});

test("a failed Pi update stops all dependent work and reports possible changes", (t) => {
  const f = fixture(t);
  const result = f.run(["update", "--json"], { MOCK_PI_FAIL: "1" });
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "partial");
  assert.equal(payload.changes, "unknown");
  assert.deepEqual(f.commands(), ["pi update --all"]);
  assert.equal(readJson(path.join(f.stateDir, "last-result.json")).status, "partial");
});

test("a non-symlink host-link is never replaced", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.npmDir, "host-link"), "keep me");
  const result = f.run(["update"]);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "host-link"), "utf8"), "keep me");
  assert.deepEqual(f.commands(), []);
  assert.match(result.stderr, /refusing to replace it/);
});

test("an existing operation lock blocks updates without running commands", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir, { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, "operation.lock"), "held\n");
  const result = f.run(["update"]);
  assert.equal(result.status, 1);
  assert.deepEqual(f.commands(), []);
  assert.match(result.stderr, /another Agentbrew operation/);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "operation.lock"), "utf8"), "held\n");
});

test("real npm install resolves local host dependencies without network packages", (t) => {
  const f = fixture(t, { realNpm: true, includeExternal: false });
  f.setHost("1.5.0");
  const result = f.run(["update", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  for (const peer of PEERS) {
    const installed = path.join(f.npmDir, "node_modules", peer);
    const target = path.join(f.npmDir, "host-deps", path.basename(peer));
    assert.equal(fs.realpathSync(installed), fs.realpathSync(target));
  }
  assert.equal(fs.existsSync(path.join(f.npmDir, "package-lock.json")), true);
});
