import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, readJson } from "./helpers.mjs";

function layer(f, kind, value) {
  const file = path.join(f.root, `${kind}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, kind: "agentbrew-layer", layer: kind, resources: {}, ...value }, null, 2)}\n`);
  return `${kind}=${file}`;
}

function npm(spec, update = "compatible") {
  return { source: { type: "npm", spec }, update };
}

test("four layers compose by kind with explicit whole-resource overrides", (t) => {
  const f = fixture(t);
  const publicLayer = layer(f, "public", { resources: { "npm:pi-subagents": npm("^0.80.0") } });
  const team = layer(f, "team", { resources: { "npm:pi-subagents": npm("^0.81.0") }, override: ["npm:pi-subagents"] });
  const personal = layer(f, "personal", { resources: { "npm:pi-subagents": npm("^0.82.0") }, override: ["npm:pi-subagents"] });
  const machine = layer(f, "machine", { resources: { "npm:pi-subagents": npm("^0.83.0") }, override: ["npm:pi-subagents"] });
  const result = f.run(["explain", "--layer", machine, "--layer", personal, "--layer", publicLayer, "--layer", team, "--resource", "npm:pi-subagents", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.resources[0].layer, "machine");
  assert.equal(payload.data.resources[0].declaration.source.spec, "^0.83.0");
  assert.deepEqual(payload.data.resources[0].history.map((event) => event.effect), ["declared", "overridden", "overridden", "overridden"]);
  assert.equal("file" in payload.data.bundle.layers[0], false);
  assert.equal(f.commands().length, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("ambiguous overrides, unsafe resources, and unknown fields fail before execution", (t) => {
  const f = fixture(t);
  const publicLayer = layer(f, "public", { resources: { "npm:pi-subagents": npm("^0.80.0") } });
  const personal = layer(f, "personal", { resources: { "npm:pi-subagents": npm("^0.82.0") } });
  const conflict = f.run(["explain", "--layer", publicLayer, "--layer", personal, "--json"]);
  assert.equal(conflict.status, 1);
  assert.match(JSON.parse(conflict.stdout).error, /explicitly override/);
  const cases = [
    { resources: { "npm:@earendil-works/pi-ai": npm("1.4.0") } },
    { resources: { "npm:pi-subagents": { ...npm("^0.83.0"), run: "echo unsafe" } } },
    { resources: { "npm:pi-subagents": { source: { type: "npm", spec: "https://example.invalid/a.tgz" }, update: "compatible" } } },
    { resources: { "npm:pi-subagents": { ...npm("^0.83.0"), unexpected: true } } },
  ];
  for (const value of cases) {
    const invalid = f.run(["explain", "--layer", layer(f, "personal", value), "--json"]);
    assert.equal(invalid.status, 1);
  }
  assert.equal(f.commands().length, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("team required and forbidden policy cannot be bypassed by higher layers", (t) => {
  const f = fixture(t);
  const publicLayer = layer(f, "public", { resources: { "npm:pi-subagents": npm("^0.83.0"), "npm:left-pad": npm("^1.0.0") } });
  const team = layer(f, "team", { required: ["npm:pi-subagents"], forbidden: ["npm:left-pad"] });
  const required = f.run(["explain", "--layer", publicLayer, "--layer", team, "--json"]);
  assert.equal(required.status, 1);
  assert.match(JSON.parse(required.stdout).error, /team-forbidden/);
  const removingRequired = layer(f, "personal", { remove: ["npm:pi-subagents", "npm:left-pad"] });
  const blocked = f.run(["explain", "--layer", publicLayer, "--layer", team, "--layer", removingRequired, "--json"]);
  assert.equal(blocked.status, 1);
  assert.match(JSON.parse(blocked.stdout).error, /team-required/);
  const cleanTeam = layer(f, "team", { required: ["npm:pi-subagents"] });
  const removeOptional = f.run(["explain", "--layer", publicLayer, "--layer", cleanTeam, "--layer", removingRequired, "--json"]);
  assert.equal(removeOptional.status, 1);
  assert.match(JSON.parse(removeOptional.stdout).error, /team-required/);
});

test("explicit tombstones and restore history are deterministic", (t) => {
  const f = fixture(t);
  const publicLayer = layer(f, "public", { resources: { "npm:pi-subagents": npm("^0.80.0"), "npm:left-pad": npm("^1.0.0") } });
  const team = layer(f, "team", { remove: ["npm:left-pad"] });
  const personal = layer(f, "personal", { resources: { "npm:pi-subagents": npm("^0.83.0"), "npm:left-pad": npm("^2.0.0") }, override: ["npm:pi-subagents", "npm:left-pad"] });
  const machine = layer(f, "machine", { remove: ["npm:left-pad"] });
  const result = f.run(["explain", "--layer", publicLayer, "--layer", team, "--layer", personal, "--layer", machine, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const leftPad = payload.data.resources.find((resource) => resource.id === "npm:left-pad");
  assert.equal(leftPad.state, "removed");
  assert.deepEqual(leftPad.history.map((event) => event.effect), ["declared", "removed", "restored", "removed"]);
});

test("diff and doctor include declaration drift without repairing or exporting host versions", (t) => {
  const f = fixture(t);
  const manifest = readJson(path.join(f.npmDir, "package.json"));
  manifest.dependencies["left-pad"] = "^1.0.0";
  fs.writeFileSync(path.join(f.npmDir, "package.json"), JSON.stringify(manifest));
  const personal = layer(f, "personal", {
    resources: { "npm:pi-subagents": npm("^0.84.0"), "npm:example-manual": npm("1.0.0", "manual") },
    remove: ["npm:left-pad"],
  });
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const diff = f.run(["diff", "--layer", personal, "--json"]);
  assert.equal(diff.status, 0, diff.stderr);
  const payload = JSON.parse(diff.stdout);
  assert.ok(payload.differences.some((item) => item.resource === "npm:pi-subagents" && item.kind === "bundle-spec"));
  assert.ok(payload.differences.some((item) => item.resource === "npm:example-manual" && item.kind === "manual-drift"));
  assert.ok(payload.differences.some((item) => item.resource === "npm:left-pad" && item.kind === "removed-resource"));
  assert.equal(resultText(diff).includes("\u001b"), false);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  assert.equal(fs.existsSync(f.stateDir), false);
  const team = layer(f, "team", { resources: { "npm:example-required": npm("^2.0.0") }, required: ["npm:example-required"] });
  const doctor = f.run(["doctor", "--layer", team, "--json"]);
  assert.equal(doctor.status, 4);
  assert.ok(JSON.parse(doctor.stdout).checks.some((check) => check.resource === "npm:example-required" && check.status === "fail"));
});

test("doctor checks the installed package version, not only the declaration", (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  assert.equal(f.run(["update"]).status, 0);
  const source = layer(f, "team", { resources: { "npm:pi-subagents": npm("^0.83.0") }, required: ["npm:pi-subagents"] });
  const healthy = f.run(["doctor", "--layer", source, "--json"]);
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.ok(JSON.parse(healthy.stdout).checks.some((check) => check.resource === "npm:pi-subagents" && check.status === "pass"));
  const installed = path.join(f.npmDir, "node_modules", "pi-subagents", "package.json");
  fs.writeFileSync(installed, JSON.stringify({ name: "pi-subagents", version: "99.0.0" }));
  const drifted = f.run(["doctor", "--layer", source, "--json"]);
  assert.equal(drifted.status, 4);
  assert.ok(JSON.parse(drifted.stdout).checks.some((check) => check.resource === "npm:pi-subagents" && check.status === "fail" && check.message.includes("99.0.0")));
  fs.rmSync(installed);
  const missing = f.run(["doctor", "--layer", source, "--json"]);
  assert.equal(missing.status, 4);
  assert.equal(f.commands().some((command) => command.includes("selftest")), false);
});

function resultText(result) {
  return `${result.stdout}${result.stderr}`;
}
