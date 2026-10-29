import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadBundle } from "../dist/bundle.js";
import { createContext } from "../dist/context.js";
import { resolveConfiguration } from "../dist/resolve.js";
import { fixture, HOST_PACKAGE } from "./helpers.mjs";

function bundle(f, resources, { kind = "personal", required } = {}) {
  const file = path.join(f.root, `${kind}-resolve.json`);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: "agentbrew-layer", layer: kind, resources, ...(required ? { required } : {}) }));
  return loadBundle([`${kind}=${file}`]);
}

function npm(spec, update = "compatible") {
  return { source: { type: "npm", spec }, update };
}

function pkg(version, peers = { [HOST_PACKAGE]: ">=1.2.0" }, integrity = "sha512-test") {
  return {
    name: "pi-subagents",
    version,
    peerDependencies: peers,
    ...(integrity ? { dist: { integrity } } : {}),
  };
}

function metadata({ release = "1.4.0", versions = {}, hostIntegrity = "sha512-host", releaseError, packumentError, packageName } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      getRelease: async () => {
        calls.push("release");
        if (releaseError) throw new Error(releaseError);
        return { version: release, ...(packageName ? { packageName } : {}) };
      },
      getManifest: async (name, version) => {
        calls.push(`manifest:${name}@${version}`);
        return {
          name,
          version,
          dependencies: {
            "@earendil-works/pi-ai": version,
            "@earendil-works/pi-agent-core": version,
            "@earendil-works/pi-tui": version,
          },
          ...(hostIntegrity ? { dist: { integrity: hostIntegrity } } : {}),
        };
      },
      getPackument: async (name) => {
        calls.push(`packument:${name}`);
        if (packumentError) throw new Error(packumentError);
        return { name, versions };
      },
    },
  };
}

function install(f, version = "0.83.0", peers = { [HOST_PACKAGE]: ">=1.2.0" }) {
  const dir = path.join(f.npmDir, "node_modules", "pi-subagents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg(version, peers)));
}

function context(f) {
  return createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
}

const defaultVersions = {
  "0.83.0": pkg("0.83.0"),
  "0.83.1": pkg("0.83.1", { [HOST_PACKAGE]: ">=1.5.0" }),
  "0.83.2": pkg("0.83.2", {}),
  "0.84.0": pkg("0.84.0"),
};

test("resolve selects the newest candidate compatible with the target host", async (t) => {
  const f = fixture(t);
  install(f);
  const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0") });
  const meta = metadata({ versions: defaultVersions });
  const report = await resolveConfiguration(context(f), source, [], meta.client);
  assert.equal(report.ready, true);
  assert.equal(report.host.targetVersion, "1.4.0");
  assert.equal(report.resources[0].targetVersion, "0.83.0");
  assert.equal(report.resources[0].action, "keep");
  assert.equal(report.errors.length, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.deepEqual(f.commands(), []);
});

test("resolution reports bounded progress messages without changing the result", async (t) => {
  const f = fixture(t);
  install(f);
  const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0") });
  const meta = metadata({ release: "1.5.0", versions: defaultVersions });
  const messages = [];
  const report = await resolveConfiguration(
    { ...context(f), progress: (message) => messages.push(message) },
    source,
    [],
    meta.client,
  );
  assert.equal(report.ready, true);
  assert.deepEqual(messages, [
    "resolving the Pi release channel…",
    "target host 1.5.0 (update)",
    "resolving 1 npm resource(s)…",
    "resolving npm:pi-subagents (1/1)…",
  ]);
});

test("a newer target host enables a newer compatible extension with integrity evidence", async (t) => {
  const f = fixture(t);
  install(f);
  const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0") });
  const meta = metadata({ release: "1.5.0", versions: defaultVersions });
  const report = await resolveConfiguration(context(f), source, [], meta.client);
  assert.equal(report.ready, true);
  assert.equal(report.host.action, "update");
  assert.equal(report.host.integrity, "sha512-host");
  assert.equal(report.resources[0].action, "update");
  assert.equal(report.resources[0].targetVersion, "0.83.1");
  assert.equal(report.resources[0].integrity, "sha512-test");
  assert.ok(report.resources[0].peerEvidence.some((peer) => peer.dependency === HOST_PACKAGE && peer.hostVersion === "1.5.0"));
});

test("fixed and manual resources evaluate only the installed version and block host changes on unknown", async (t) => {
  for (const policy of ["fixed", "manual"]) {
    const f = fixture(t);
    install(f, "0.83.0", {});
    const source = bundle(f, { "npm:pi-subagents": npm("0.83.0", policy) });
    const meta = metadata({ release: "1.5.0", versions: defaultVersions });
    const report = await resolveConfiguration(context(f), source, [], meta.client);
    assert.equal(report.resources[0].action, "unknown");
    assert.equal(report.resources[0].targetVersion, null);
    assert.equal(report.ready, false);
    assert.equal(report.complete, false);
    assert.equal(meta.calls.includes("packument:pi-subagents"), false);
  }
});

test("unknown existing resources may remain when the host does not change", async (t) => {
  const f = fixture(t);
  install(f, "0.83.0", {});
  const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0") });
  const versions = { "0.83.0": pkg("0.83.0", {}) };
  const report = await resolveConfiguration(context(f), source, [], metadata({ versions }).client);
  assert.equal(report.resources[0].action, "unknown");
  assert.equal(report.ready, true);
  assert.equal(report.complete, false);
});

test("new required resources without peer evidence or integrity are blocked", async (t) => {
  for (const integrity of [null, "sha512-test"]) {
    const f = fixture(t);
    const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0") }, { kind: "team", required: ["npm:pi-subagents"] });
    const versions = { "0.83.1": pkg("0.83.1", {}, integrity) };
    const report = await resolveConfiguration(context(f), source, [], metadata({ versions }).client);
    assert.equal(report.resources[0].action, "blocked");
    assert.equal(report.ready, false);
  }
});

test("metadata failure preserves current resources but marks resolution incomplete", async (t) => {
  const f = fixture(t);
  install(f);
  const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0") });
  const report = await resolveConfiguration(context(f), source, [], metadata({ packumentError: "offline test" }).client);
  assert.equal(report.resources[0].action, "unknown");
  assert.equal(report.resources[0].currentVersion, "0.83.0");
  assert.equal(report.complete, false);
  assert.equal(report.ready, false);
  assert.equal(report.errors.length, 1);
});

test("an older release never plans a host downgrade", async (t) => {
  const f = fixture(t);
  install(f);
  const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0") });
  const meta = metadata({ release: "1.3.0", versions: defaultVersions });
  const report = await resolveConfiguration(context(f), source, [], meta.client);
  assert.equal(report.host.targetVersion, "1.4.0");
  assert.equal(report.host.action, "keep");
  assert.ok(meta.calls.includes(`manifest:${HOST_PACKAGE}@1.4.0`));
});

test("invalid release identity and missing host integrity fail closed", async (t) => {
  const f = fixture(t);
  install(f);
  const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0") });
  const wrong = await resolveConfiguration(context(f), source, [], metadata({ packageName: "unexpected", versions: defaultVersions }).client);
  assert.equal(wrong.host, null);
  assert.equal(wrong.ready, false);
  assert.equal(wrong.errors.length, 1);
  const missing = await resolveConfiguration(context(f), source, [], metadata({ release: "1.5.0", hostIntegrity: null, versions: defaultVersions }).client);
  assert.equal(missing.ready, false);
  assert.match(missing.errors[0].message, /integrity/);
});

test("resource selection limits resolution without changing configuration", async (t) => {
  const f = fixture(t);
  install(f);
  const source = bundle(f, { "npm:pi-subagents": npm("^0.83.0"), "npm:left-pad": npm("^1.0.0") });
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const meta = metadata({ versions: defaultVersions });
  const report = await resolveConfiguration(context(f), source, ["npm:pi-subagents"], meta.client);
  assert.deepEqual(report.resources.map((resource) => resource.id), ["npm:pi-subagents"]);
  assert.equal(meta.calls.includes("packument:left-pad"), false);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  assert.equal(fs.existsSync(f.stateDir), false);
  await assert.rejects(resolveConfiguration(context(f), source, ["npm:missing"], meta.client), /not active/);
});
