import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";

function manifestFile(f) {
  return path.join(f.npmDir, "package.json");
}

function emptyFixture(t) {
  const f = fixture(t);
  fs.rmSync(f.npmDir, { recursive: true, force: true });
  return f;
}

function freshArgs(resources = ["pi.base"], extra = []) {
  return ["init", "--expect", "empty", "--mode", "fresh", ...resources.flatMap((id) => ["--resource", id]), ...extra];
}

test("init assessment is aggregated, read-only, and requires explicit non-interactive choices", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(manifestFile(f), "utf8");
  const summary = f.run(["init"]);
  assert.equal(summary.status, 6);
  assert.match(summary.stderr, /classification: repairable/);
  assert.equal(summary.stderr.includes("DIFF @earendil-works"), false);
  const verbose = f.run(["init", "--verbose"]);
  assert.equal(verbose.status, 6);
  assert.match(verbose.stderr, /DIFF @earendil-works/);
  const json = f.run(["init", "--json"]);
  assert.equal(json.status, 6);
  assert.equal(JSON.parse(json.stdout).data.assessment.classification, "repairable");
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(f.commands().some((command) => command.includes("selftest") || command.includes(" install") || command.includes("update --all")), false);
});

test("Observe is explicit and writes neither configuration nor local state", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(manifestFile(f), "utf8");
  const result = f.run(["init", "--expect", "repairable", "--mode", "observe", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changes, "none");
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("Adopt records selected ownership without normalization or future native updates", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(manifestFile(f), "utf8");
  const result = f.run(["init", "--expect", "repairable", "--mode", "adopt", "--resource", "pi.host", "--resource", "npm:pi-subagents", "--apply", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
  const ownership = readJson(path.join(f.stateDir, "ownership.json"));
  assert.equal(ownership.resources["pi.host"], "adopt");
  assert.equal(ownership.resources["npm:pi-subagents"], "adopt");
  assert.equal(ownership.resources["pi.host-links"], "observe");
  assert.equal(f.commands().some((command) => command.includes(" install") || command.includes("update --all")), false);
  fs.writeFileSync(f.log, "");
  const update = f.run(["update", "--json"]);
  assert.equal(update.status, 6);
  assert.equal(JSON.parse(update.stdout).changes, "none");
  assert.deepEqual(f.commands(), []);
});

test("Repair fixes only generated links and integration while preserving the manifest", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.herdrStatus, "outdated");
  const before = fs.readFileSync(manifestFile(f), "utf8");
  const result = f.run(["init", "--expect", "repairable", "--mode", "repair", "--resource", "pi.host-links", "--resource", "herdr.pi-integration", "--apply", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
  assert.equal(fs.lstatSync(path.join(f.npmDir, "host-link")).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "extensions", "herdr-agent-state.ts"), "utf8"), "generated\n");
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.equal(f.commands().some((command) => command.startsWith("npm install")), false);
  const ownership = readJson(path.join(f.stateDir, "ownership.json"));
  assert.equal(ownership.resources["pi.host-links"], "generate");
  assert.equal(ownership.resources["herdr.pi-integration"], "generate");
  assert.equal(ownership.resources["pi.host"], "observe");
  assert.equal(f.run(["update"]).status, 6);
});

test("Manage normalizes only the explicitly selected host declaration", (t) => {
  const f = fixture(t);
  const before = readJson(manifestFile(f));
  const result = f.run(["init", "--expect", "repairable", "--mode", "manage", "--resource", "pi.host", "--apply", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const after = readJson(manifestFile(f));
  assert.equal(after.dependencies[HOST_PACKAGE], "file:host-link");
  for (const peer of PEERS) assert.equal(after.dependencies[peer], before.dependencies[peer]);
  assert.equal(after.dependencies["pi-subagents"], before.dependencies["pi-subagents"]);
  assert.equal(fs.existsSync(path.join(f.npmDir, "host-link")), false);
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.equal(f.commands().some((command) => command.startsWith("npm install")), false);
});

test("Manage can explicitly cover all native resources and then permit update", (t) => {
  const f = fixture(t);
  const resources = ["pi.host", "pi.host-links", "herdr.pi-integration", ...PEERS.map((name) => `npm:${name}`), "npm:pi-subagents"];
  const args = ["init", "--expect", "repairable", "--mode", "manage", ...resources.flatMap((id) => ["--resource", id]), "--apply"];
  const initialized = f.run(args);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.equal(f.commands().some((command) => command.startsWith("npm install")), false);
  f.setHost("1.5.0");
  const updated = f.run(["update", "--selftest"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(f.commands().includes("pi update --all"), true);
  assert.equal(f.commands().some((command) => command.startsWith("npm install")), true);
});

test("Fresh install creates only the minimal portable base and selected integration", (t) => {
  const f = emptyFixture(t);
  const result = f.run(freshArgs(["pi.base", "herdr.pi-integration"], ["--apply", "--json"]));
  assert.equal(result.status, 0, result.stderr);
  const manifest = readJson(manifestFile(f));
  assert.equal(manifest.dependencies[HOST_PACKAGE], "file:host-link");
  for (const peer of PEERS) assert.equal(manifest.dependencies[peer], `file:host-deps/${path.basename(peer)}`);
  assert.equal("pi-subagents" in manifest.dependencies, false);
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.equal(f.commands().some((command) => command.includes("selftest")), false);
  assert.equal(f.commands().includes("npm install --ignore-scripts --legacy-peer-deps"), true);
  assert.equal(f.commands().includes("herdr integration install pi"), false);
  assert.equal(f.run(["doctor"]).status, 0);
});

test("Fresh base-only install leaves integration optional and skips it during update", (t) => {
  const f = emptyFixture(t);
  fs.writeFileSync(f.herdrStatus, "outdated");
  const result = f.run(freshArgs(["pi.base"], ["--apply", "--json"]));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.commands().includes("herdr integration install pi"), false);
  assert.equal(f.run(["doctor"]).status, 0);
  f.setHost("1.5.0");
  fs.writeFileSync(f.log, "");
  const update = f.run(["update", "--json"]);
  assert.equal(update.status, 0, update.stderr);
  assert.equal(f.commands().includes("herdr integration install pi"), false);
  assert.equal(JSON.parse(update.stdout).steps.find((step) => step.id === "herdr-integration").status, "skipped");
});

test("Fresh install without a host stops before creating configuration or state", (t) => {
  const f = emptyFixture(t);
  fs.rmSync(path.join(f.agentDir, "install"), { recursive: true, force: true });
  const result = f.run(freshArgs(["pi.base"], ["--apply", "--json"]));
  assert.equal(result.status, 6);
  assert.match(JSON.parse(result.stdout).error, /working Pi host/);
  assert.equal(fs.existsSync(f.npmDir), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("Malformed and unknown nonempty targets cannot enter Fresh install", (t) => {
  const broken = fixture(t);
  fs.writeFileSync(manifestFile(broken), "{");
  const damaged = broken.run(freshArgs(["pi.base"], ["--apply", "--json"]));
  assert.equal(damaged.status, 6);
  assert.equal(fs.existsSync(broken.stateDir), false);

  const unknown = emptyFixture(t);
  fs.writeFileSync(path.join(unknown.agentDir, "settings.json"), "{}\n");
  const assessment = unknown.run(["init", "--json"]);
  assert.equal(JSON.parse(assessment.stdout).data.assessment.classification, "unknown");
  const blocked = unknown.run(freshArgs(["pi.base"], ["--apply"]));
  assert.equal(blocked.status, 6);
  assert.equal(fs.existsSync(path.join(unknown.agentDir, "npm", "package.json")), false);
});

test("Missing resources, apply authorization, and a generic yes flag cannot authorize init", (t) => {
  const f = fixture(t);
  const missingResource = f.run(["init", "--expect", "repairable", "--mode", "repair", "--apply"]);
  assert.equal(missingResource.status, 6);
  const missingApply = f.run(["init", "--expect", "repairable", "--mode", "repair", "--resource", "pi.host-links"]);
  assert.equal(missingApply.status, 6);
  const yes = f.run(["init", "--expect", "repairable", "--mode", "repair", "--resource", "pi.host-links", "--yes"]);
  assert.equal(yes.status, 2);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(fs.existsSync(path.join(f.npmDir, "host-link")), false);
});

test("plan-out and apply are separate, and a fresh repair plan is idempotent", (t) => {
  const f = fixture(t);
  const plan = path.join(f.root, "repair-plan.json");
  const planned = f.run(["init", "--expect", "repairable", "--mode", "repair", "--resource", "pi.host-links", "--plan-out", plan, "--json"]);
  assert.equal(planned.status, 6);
  assert.equal(fs.existsSync(plan), true);
  assert.equal(fs.existsSync(f.stateDir), false);
  const applied = f.run(["apply", "--plan", plan, "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  const firstManifest = fs.readFileSync(manifestFile(f), "utf8");
  const repeated = f.run(["init", "--expect", "repairable", "--mode", "repair", "--resource", "pi.host-links", "--apply", "--json"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).changes, "none");
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), firstManifest);
  const stale = f.run(["apply", "--plan", plan, "--json"]);
  assert.equal(stale.status, 6);
});

test("Apply rejects target drift and tampered actions before writing", (t) => {
  const f = fixture(t);
  const plan = path.join(f.root, "plan.json");
  assert.equal(f.run(["init", "--expect", "repairable", "--mode", "repair", "--resource", "pi.host-links", "--plan-out", plan]).status, 6);
  const value = readJson(plan);
  value.actions.push("generate-herdr-integration");
  fs.writeFileSync(plan, JSON.stringify(value));
  const tampered = f.run(["apply", "--plan", plan, "--json"]);
  assert.equal(tampered.status, 6);
  assert.equal(fs.existsSync(f.stateDir), false);

  const driftPlan = path.join(f.root, "drift-plan.json");
  assert.equal(f.run(["init", "--expect", "repairable", "--mode", "repair", "--resource", "pi.host-links", "--plan-out", driftPlan]).status, 6);
  const manifest = readJson(manifestFile(f));
  manifest.dependencies["pi-subagents"] = "^99.0.0";
  fs.writeFileSync(manifestFile(f), JSON.stringify(manifest));
  const drifted = f.run(["apply", "--plan", driftPlan, "--json"]);
  assert.equal(drifted.status, 6);
  assert.equal(fs.existsSync(path.join(f.npmDir, "host-link")), false);
});

test("Unsafe links and escaping npm directories are never replaced", (t) => {
  const damaged = fixture(t);
  const link = path.join(damaged.npmDir, "host-link");
  fs.writeFileSync(link, "keep me");
  const assessment = damaged.run(["init", "--json"]);
  assert.equal(JSON.parse(assessment.stdout).data.assessment.classification, "damaged");
  const repaired = damaged.run(["init", "--expect", "damaged", "--mode", "repair", "--resource", "pi.host-links", "--apply"]);
  assert.equal(repaired.status, 1);
  assert.equal(fs.readFileSync(link, "utf8"), "keep me");

  const escaping = emptyFixture(t);
  const outside = path.join(escaping.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, escaping.npmDir, "dir");
  const evaluation = escaping.run(["init", "--json"]);
  assert.equal(JSON.parse(evaluation.stdout).data.assessment.classification, "unknown");
  const blocked = escaping.run(freshArgs(["pi.base"], ["--apply"]));
  assert.equal(blocked.status, 6);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("Healthy configuration is not forced through Repair or Fresh install", (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  assert.equal(f.run(["update"]).status, 0);
  const before = fs.readFileSync(manifestFile(f), "utf8");
  const assessment = f.run(["init", "--json"]);
  assert.equal(JSON.parse(assessment.stdout).data.assessment.classification, "healthy");
  const repair = f.run(["init", "--expect", "healthy", "--mode", "repair", "--resource", "pi.host-links", "--apply", "--json"]);
  assert.equal(repair.status, 6);
  const fresh = f.run(freshArgs(["pi.base"], ["--apply", "--json"]));
  assert.equal(fresh.status, 6);
  assert.equal(fs.readFileSync(manifestFile(f), "utf8"), before);
});

test("A partial Fresh failure is recorded as partial without managed ownership", (t) => {
  const f = emptyFixture(t);
  const result = f.run(freshArgs(["pi.base"], ["--apply", "--json"]), { MOCK_NPM_FAIL: "1" });
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "partial");
  assert.equal(payload.steps.some((step) => step.status === "failed"), true);
  assert.equal(readJson(path.join(f.stateDir, "last-result.json")).status, "partial");
  assert.equal(fs.existsSync(path.join(f.stateDir, "ownership.json")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "last-snapshot.json")), true);
});

test("real npm can install the minimal Fresh host links without network packages", (t) => {
  const f = fixture(t, { realNpm: true, includeExternal: false });
  fs.rmSync(f.npmDir, { recursive: true, force: true });
  const result = f.run(freshArgs(["pi.base"], ["--apply", "--json"]));
  assert.equal(result.status, 0, result.stderr);
  const installedHost = path.join(f.npmDir, "node_modules", HOST_PACKAGE);
  assert.equal(fs.realpathSync(installedHost), fs.realpathSync(path.join(f.npmDir, "host-link")));
  for (const peer of PEERS) {
    const installed = path.join(f.npmDir, "node_modules", peer);
    const target = path.join(f.npmDir, "host-deps", path.basename(peer));
    assert.equal(fs.realpathSync(installed), fs.realpathSync(target));
  }
  assert.equal(fs.existsSync(path.join(f.npmDir, "package-lock.json")), true);
});

test("An unselected outdated integration does not force a healthy target into Repair", (t) => {
  const f = emptyFixture(t);
  assert.equal(f.run(freshArgs(["pi.base"], ["--apply"])).status, 0);
  fs.writeFileSync(f.herdrStatus, "outdated");
  const result = f.run(["init", "--json"]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.assessment.classification, "healthy");
  assert.equal(payload.checks.find((check) => check.resource === "herdr.pi-integration").status, "warn");
});

test("Apply rejects host manifest changes made after a Fresh plan", (t) => {
  const f = emptyFixture(t);
  const plan = path.join(f.root, "fresh-plan.json");
  const planned = f.run(freshArgs(["pi.base"], ["--plan-out", plan]));
  assert.equal(planned.status, 6);
  const hostManifest = path.join(f.agentDir, "install", "releases", "1.4.0", "node_modules", HOST_PACKAGE, "package.json");
  const value = readJson(hostManifest);
  value.description = "changed after authorization";
  fs.writeFileSync(hostManifest, JSON.stringify(value));
  const applied = f.run(["apply", "--plan", plan, "--json"]);
  assert.equal(applied.status, 6);
  assert.equal(fs.existsSync(f.npmDir), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});
