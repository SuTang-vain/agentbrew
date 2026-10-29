import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, PEERS, readJson } from "./helpers.mjs";
import { metadataServer } from "./metadata-server.mjs";

function layer(f, value, kind = "personal") {
  const file = path.join(f.root, `${kind}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, kind: "agentbrew-layer", layer: kind, resources: {}, ...value }, null, 2)}\n`);
  return `${kind}=${file}`;
}

function npm(spec, update = "compatible") {
  return { source: { type: "npm", spec }, update };
}

function manifestFile(f) {
  return path.join(f.npmDir, "package.json");
}

function healthy(f) {
  f.setHost("1.5.0");
  const result = f.run(["update"]);
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(f.log, "");
}

function plan(f, layerArgument, resources, output = path.join(f.root, "bundle-plan.json")) {
  return f.run(["diff", "--layer", layerArgument, "--mode", "manage", ...resources.flatMap((id) => ["--resource", id]), "--plan-out", output, "--json"]);
}

function manageAll(f) {
  const resources = ["pi.host", "pi.host-links", "herdr.pi-integration", ...PEERS.map((name) => `npm:${name}`), "npm:pi-subagents"];
  const result = f.run(["init", "--expect", "healthy", "--mode", "manage", ...resources.flatMap((id) => ["--resource", id]), "--apply", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(f.log, "");
}

test("Bundle plan applies only selected npm resources, then verifies and records ownership", (t) => {
  const f = fixture(t);
  healthy(f);
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.84.0"), "npm:left-pad": npm("^1.0.0") } });
  const before = readJson(manifestFile(f));
  const planned = plan(f, source, ["npm:pi-subagents"]);
  assert.equal(planned.status, 6, planned.stderr);
  const planFile = path.join(f.root, "bundle-plan.json");
  assert.equal(fs.existsSync(planFile), true);
  assert.equal(fs.existsSync(f.stateDir), true);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
  assert.deepEqual(readJson(manifestFile(f)), before);
  assert.equal(f.commands().some((command) => command.startsWith("npm install")), false);
  const applied = f.run(["apply", "--plan", planFile, "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  const after = readJson(manifestFile(f));
  assert.equal(after.dependencies["pi-subagents"], "^0.84.0");
  assert.equal("left-pad" in after.dependencies, false);
  for (const peer of PEERS) assert.equal(after.dependencies[peer], before.dependencies[peer]);
  assert.equal(readJson(path.join(f.stateDir, "ownership.json")).resources["npm:pi-subagents"], "manage");
  assert.equal(f.commands().includes("npm install --ignore-scripts --legacy-peer-deps"), true);
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.equal(f.commands().some((command) => command.includes("selftest")), false);
  const repeated = f.run(["apply", "--plan", planFile, "--json"]);
  assert.equal(repeated.status, 6);
  assert.equal(readJson(manifestFile(f)).dependencies["pi-subagents"], "^0.84.0");
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
});

test("an explicit tombstone removes only the selected declaration", (t) => {
  const f = fixture(t);
  healthy(f);
  const manifest = readJson(manifestFile(f));
  manifest.dependencies["left-pad"] = "^1.0.0";
  fs.writeFileSync(manifestFile(f), JSON.stringify(manifest));
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.83.0") }, remove: ["npm:left-pad"] });
  assert.equal(plan(f, source, ["npm:left-pad"]).status, 6);
  const applied = f.run(["apply", "--plan", path.join(f.root, "bundle-plan.json"), "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  const after = readJson(manifestFile(f));
  assert.equal("left-pad" in after.dependencies, false);
  assert.equal(after.dependencies["pi-subagents"], "^0.83.0");
  assert.equal("npm:left-pad" in readJson(path.join(f.stateDir, "ownership.json")).resources, false);
});

test("Bundle apply can repair only the selected herdr integration", (t) => {
  const f = fixture(t);
  healthy(f);
  fs.writeFileSync(f.herdrStatus, "outdated");
  const source = layer(f, { resources: { "herdr.pi-integration": { update: "compatible" } } });
  assert.equal(plan(f, source, ["herdr.pi-integration"]).status, 6);
  const applied = f.run(["apply", "--plan", path.join(f.root, "bundle-plan.json"), "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(f.herdrStatus, "utf8").trim(), "current");
  assert.equal(readJson(path.join(f.stateDir, "ownership.json")).resources["herdr.pi-integration"], "generate");
  assert.equal(f.commands().includes("herdr integration install pi"), true);
  assert.equal(f.commands().some((command) => command.startsWith("npm install") || command.includes("pi update")), false);
});

test("tampered actions and changed sources stop before any managed write", (t) => {
  const f = fixture(t);
  healthy(f);
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.84.0") } });
  const planFile = path.join(f.root, "bundle-plan.json");
  assert.equal(plan(f, source, ["npm:pi-subagents"]).status, 6);
  const before = fs.readFileSync(manifestFile(f), "utf8");
  const tampered = readJson(planFile);
  tampered.actions[0].spec = "^99.0.0";
  fs.writeFileSync(planFile, JSON.stringify(tampered));
  const rejected = f.run(["apply", "--plan", planFile, "--json"]);
  assert.equal(rejected.status, 6);
  assert.match(JSON.parse(rejected.stdout).error, /actions do not match/);
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
  const sourceFile = source.slice(source.indexOf("=") + 1);
  fs.writeFileSync(sourceFile, JSON.stringify({ schemaVersion: 1, kind: "agentbrew-layer", layer: "personal", resources: { "npm:pi-subagents": npm("^0.85.0") } }));
  const changedSource = f.run(["apply", "--plan", planFile, "--json"]);
  assert.equal(changedSource.status, 6);
  assert.match(JSON.parse(changedSource.stdout).error, /sources changed/);
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
  assert.equal(f.commands().some((command) => command.startsWith("npm install") || command.includes("pi update")), false);
});

test("target, manifest, and ownership drift invalidate the reviewed plan", (t) => {
  const f = fixture(t);
  healthy(f);
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.84.0") } });
  const planFile = path.join(f.root, "bundle-plan.json");
  assert.equal(plan(f, source, ["npm:pi-subagents"]).status, 6);
  const before = fs.readFileSync(manifestFile(f), "utf8");
  const manifest = readJson(manifestFile(f));
  manifest.dependencies["pi-subagents"] = "^0.90.0";
  fs.writeFileSync(manifestFile(f), JSON.stringify(manifest));
  const drift = f.run(["apply", "--plan", planFile, "--json"]);
  assert.equal(drift.status, 6);
  assert.equal(readJson(manifestFile(f)).dependencies["pi-subagents"], "^0.90.0");
  fs.writeFileSync(manifestFile(f), before);
  const lockFile = path.join(f.npmDir, "package-lock.json");
  fs.writeFileSync(lockFile, "{}\n");
  const lockDrift = f.run(["apply", "--plan", planFile, "--json"]);
  assert.equal(lockDrift.status, 6);
  fs.rmSync(lockFile);
  fs.mkdirSync(f.stateDir, { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, "ownership.json"), JSON.stringify({ schemaVersion: 1, resources: {} }));
  const ownership = f.run(["apply", "--plan", planFile, "--json"]);
  assert.equal(ownership.status, 6);
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
  assert.equal(f.commands().some((command) => command.startsWith("npm install")), false);
});

test("npm failure is partial and does not grant ownership or leave a lock", (t) => {
  const f = fixture(t);
  healthy(f);
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.84.0") } });
  const planFile = path.join(f.root, "bundle-plan.json");
  assert.equal(plan(f, source, ["npm:pi-subagents"]).status, 6);
  const applied = f.run(["apply", "--plan", planFile, "--json"], { MOCK_NPM_FAIL: "1" });
  assert.equal(applied.status, 3);
  const payload = JSON.parse(applied.stdout);
  assert.equal(payload.changes, "observed");
  assert.equal(payload.steps.find((step) => step.id === "bundle-npm-install").status, "failed");
  assert.equal(readJson(manifestFile(f)).dependencies["pi-subagents"], "^0.84.0");
  assert.equal(fs.existsSync(path.join(f.stateDir, "ownership.json")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
  assert.equal(readJson(path.join(f.stateDir, "last-result.json")).status, "partial");
});

test("fixed/manual resources are retained while compatible resources use exact resolved updates", async (t) => {
  for (const policy of ["fixed", "manual"]) {
    const f = fixture(t);
    healthy(f);
    const manifest = readJson(manifestFile(f));
    manifest.dependencies["pi-subagents"] = "0.83.0";
    fs.writeFileSync(manifestFile(f), JSON.stringify(manifest));
    manageAll(f);
    const source = layer(f, { resources: { "npm:pi-subagents": npm("0.83.0", policy) } });
    const metadata = await metadataServer(t);
    const result = f.run(["update", "--layer", source, "--json"], metadata.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.resolution.resources[0].action, "keep");
    assert.equal(f.commands().includes("pi update --all"), false);
    assert.equal(f.commands().some((line) => line.startsWith("npm install")), false);
  }
  const f = fixture(t);
  healthy(f);
  manageAll(f);
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.83.0") } });
  const metadata = await metadataServer(t);
  const updated = f.run(["update", "--layer", source, "--json"], metadata.env);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.equal(f.commands().includes("npm install --package-lock-only --ignore-scripts --legacy-peer-deps"), true);
  assert.equal(f.commands().includes("npm install --ignore-scripts --legacy-peer-deps"), true);
  assert.equal(f.commands().some((command) => command.includes("--no-save")), false);
});

test("Bundle update stops on drift or absent local ownership before native execution", (t) => {
  const f = fixture(t);
  healthy(f);
  manageAll(f);
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.84.0") } });
  const drift = f.run(["update", "--layer", source, "--json"]);
  assert.equal(drift.status, 6);
  assert.match(JSON.parse(drift.stdout).error, /declarations differ/);
  assert.equal(f.commands().includes("pi update --all"), false);
  const other = fixture(t);
  healthy(other);
  const matching = layer(other, { resources: { "npm:pi-subagents": npm("^0.83.0") } });
  const noOwnership = other.run(["update", "--layer", matching, "--json"]);
  assert.equal(noOwnership.status, 6);
  assert.match(JSON.parse(noOwnership.stdout).error, /local ownership/);
  assert.equal(other.commands().includes("pi update --all"), false);
});

test("plan generation requires explicit resources and manage authorization", (t) => {
  const f = fixture(t);
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.84.0") } });
  const output = path.join(f.root, "unauthorized.json");
  const missingMode = f.run(["diff", "--layer", source, "--resource", "npm:pi-subagents", "--plan-out", output, "--json"]);
  assert.equal(missingMode.status, 6);
  assert.equal(fs.existsSync(output), false);
  const missingResources = plan(f, source, [], output);
  assert.equal(missingResources.status, 6);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("arbitrary plan actions are rejected and plan-out never overwrites a file", (t) => {
  const f = fixture(t);
  healthy(f);
  const source = layer(f, { resources: { "npm:pi-subagents": npm("^0.84.0") } });
  const planFile = path.join(f.root, "bundle-plan.json");
  assert.equal(plan(f, source, ["npm:pi-subagents"]).status, 6);
  const original = fs.readFileSync(planFile, "utf8");
  const repeated = plan(f, source, ["npm:pi-subagents"]);
  assert.equal(repeated.status, 6);
  assert.equal(fs.readFileSync(planFile, "utf8"), original);
  const value = readJson(planFile);
  value.actions = [{ type: "run", resource: "npm:pi-subagents", command: "echo unsafe" }];
  fs.writeFileSync(planFile, JSON.stringify(value));
  const before = fs.readFileSync(manifestFile(f), "utf8");
  const rejected = f.run(["apply", "--plan", planFile, "--json"]);
  assert.equal(rejected.status, 6);
  assert.match(JSON.parse(rejected.stdout).error, /unsupported action/);
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
  assert.equal(f.commands().some((command) => command.startsWith("npm install") || command.includes("echo unsafe")), false);
});
