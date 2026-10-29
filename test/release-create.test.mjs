import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadBundle } from "../dist/bundle.js";
import { fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";
import { metadataServer } from "./metadata-server.mjs";

const INTEGRITY = `sha512-${Buffer.alloc(64, 11).toString("base64")}`;

function manage(f) {
  const resources = {
    "pi.host": "manage",
    "pi.host-links": "manage",
    "herdr.pi-integration": "generate",
    ...Object.fromEntries([...PEERS, "pi-subagents"].map((name) => [`npm:${name}`, "manage"])),
  };
  fs.mkdirSync(f.stateDir, { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, "ownership.json"), JSON.stringify({ schemaVersion: 1, resources }));
}

async function prepare(t) {
  const f = fixture(t);
  f.setHost("1.5.0");
  fs.rmSync(path.join(f.agentDir, "install", "releases", "1.5.0"), { recursive: true, force: true });
  const installed = path.join(f.npmDir, "node_modules", "pi-subagents");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({
    name: "pi-subagents",
    version: "0.83.0",
    peerDependencies: { [HOST_PACKAGE]: ">=1.2.0" },
  }));
  manage(f);
  const file = path.join(f.root, "team.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "team",
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.83.0" }, update: "compatible" } },
    required: ["npm:pi-subagents"],
  }));
  const metadata = await metadataServer(t, {
    versions: { "0.83.1": { peers: { [HOST_PACKAGE]: ">=1.5.0" }, integrity: INTEGRITY } },
  });
  const source = `team=${file}`;
  const updated = f.run(["update", "--layer", source, "--json"], { ...metadata.env, MOCK_NPM_INTEGRITY: INTEGRITY });
  assert.equal(updated.status, 0, updated.stderr || updated.stdout);
  return { f, source, output: path.join(f.root, "published.json") };
}

test("release create exports only portable fixed evidence and supports explicit runtime verification", async (t) => {
  const { f, source, output } = await prepare(t);
  const created = f.run(["release", "create", "--layer", source, "--output", output, "--json"]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const result = JSON.parse(created.stdout);
  assert.equal(result.data.runtimeLoad, "unknown");
  assert.match(result.data.warning, /static health evidence/);
  const release = readJson(output);
  assert.equal(release.kind, "agentbrew-release");
  assert.equal(release.layer, "team");
  assert.equal(release.resources["npm:pi-subagents"].update, "fixed");
  assert.equal(release.resources["npm:pi-subagents"].source.spec, "0.83.1");
  assert.equal(release.resources["npm:pi-subagents"].source.integrity, INTEGRITY);
  assert.equal(release.verification.runtimeLoad, "unknown");
  assert.equal("host" in release, false);
  const text = fs.readFileSync(output, "utf8");
  assert.equal(text.includes(f.home), false);
  assert.equal(text.includes(f.agentDir), false);
  assert.equal(text.includes("host-link"), false);
  assert.equal(loadBundle([`team=${output}`]).release.runtimeLoad, "unknown");
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(f.run(["release", "create", "--layer", source, "--output", output, "--json"]).status, 1);

  const runtimeOutput = path.join(f.root, "published-runtime.json");
  const runtime = f.run(["release", "create", "--layer", source, "--output", runtimeOutput, "--selftest", "--host-range", ">=1.5.0 <2.0.0", "--json"]);
  assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
  const verified = readJson(runtimeOutput);
  assert.equal(verified.verification.runtimeLoad, "passed");
  assert.equal(verified.host.compatible, ">=1.5.0 <2.0.0");
});

test("release create rejects personal sources, stale evidence, and exact host ranges without output", async (t) => {
  const { f, source, output } = await prepare(t);
  const personal = path.join(f.root, "personal.json");
  fs.writeFileSync(personal, JSON.stringify({ schemaVersion: 1, kind: "agentbrew-layer", layer: "personal", resources: {} }));
  const rejected = f.run(["release", "create", "--layer", `personal=${personal}`, "--output", output, "--json"]);
  assert.equal(rejected.status, 6, rejected.stderr || rejected.stdout);
  assert.equal(fs.existsSync(output), false);
  assert.equal(f.run(["release", "create", "--layer", source, "--output", output, "--host-range", "1.5.0", "--json"]).status, 6);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json"), JSON.stringify({ name: "pi-subagents", version: "99.0.0" }));
  const stale = f.run(["release", "create", "--layer", source, "--output", output, "--json"]);
  assert.equal(stale.status, 6, stale.stderr || stale.stdout);
  assert.match(JSON.parse(stale.stdout).error, /no longer matches/);
  assert.equal(fs.existsSync(output), false);
});

test("release create requires successful matching resolution evidence", async (t) => {
  const { f, source, output } = await prepare(t);
  const resultFile = path.join(f.stateDir, "last-result.json");
  const last = readJson(resultFile);
  last.status = "partial";
  fs.writeFileSync(resultFile, JSON.stringify(last));
  const result = f.run(["release", "create", "--layer", source, "--output", output, "--json"]);
  assert.equal(result.status, 6, result.stderr || result.stdout);
  assert.match(JSON.parse(result.stdout).error, /successful resolved update/);
  assert.equal(fs.existsSync(output), false);
});
