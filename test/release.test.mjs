import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadBundle } from "../dist/bundle.js";
import { createContext } from "../dist/context.js";
import { resolveConfiguration } from "../dist/resolve.js";
import { fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";
import { metadataServer } from "./metadata-server.mjs";

const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const OTHER_INTEGRITY = `sha512-${Buffer.alloc(64, 8).toString("base64")}`;

function pin(spec, integrity = INTEGRITY) {
  return { source: { type: "npm", spec, integrity }, update: "fixed" };
}

function compatible(spec) {
  return { source: { type: "npm", spec }, update: "compatible" };
}

function release(f, resources, options = {}) {
  const file = path.join(f.root, options.fileName ?? "team-release.json");
  const layer = options.layer ?? "team";
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    kind: options.kind ?? "agentbrew-release",
    layer,
    release: "team-2026-10",
    resources,
    ...options,
  }, null, 2));
  return `${layer}=${file}`;
}

function personal(f, resources, extra = {}) {
  const file = path.join(f.root, "personal-release-override.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: "agentbrew-layer", layer: "personal", resources, ...extra }));
  return `personal=${file}`;
}

function install(f, version = "0.83.0") {
  const dir = path.join(f.npmDir, "node_modules", "pi-subagents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "pi-subagents",
    version,
    peerDependencies: { [HOST_PACKAGE]: ">=1.2.0" },
  }));
}

function context(f, subject = {}) {
  return createContext({ agentDir: f.agentDir, stateDir: f.stateDir, ...subject }, f.env());
}

function metadata({ releaseVersion = "1.5.0", pinIntegrity = INTEGRITY, peerRange = ">=1.5.0" } = {}) {
  return {
    getRelease: async () => ({ version: releaseVersion, packageName: HOST_PACKAGE }),
    getManifest: async (name, version) => name === HOST_PACKAGE ? {
      name,
      version,
      dependencies: { "@earendil-works/pi-ai": version },
      dist: { integrity: "sha512-host" },
    } : {
      name,
      version,
      peerDependencies: { [HOST_PACKAGE]: peerRange },
      dist: { integrity: pinIntegrity },
    },
    getPackument: async (name) => ({ name, versions: {} }),
  };
}

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

test("Release is a team input with portable fixed evidence", (t) => {
  const f = fixture(t);
  const source = release(f, { "npm:pi-subagents": pin("0.83.1") }, {
    required: ["npm:pi-subagents"],
    host: { compatible: ">=1.2.0 <2.0.0" },
  });
  const result = f.run(["explain", "--layer", source, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.bundle.release.name, "team-2026-10");
  assert.equal(payload.data.bundle.release.hostCompatible, ">=1.2.0 <2.0.0");
  assert.equal(payload.data.resources[0].declaration.source.integrity, INTEGRITY);
  assert.equal(result.stdout.includes(f.agentDir), true);
  assert.equal(fs.readFileSync(source.slice(5), "utf8").includes(f.agentDir), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("Release rejects exact hosts, invalid pins, misplaced inputs, and useless exceptions", (t) => {
  const f = fixture(t);
  const cases = [
    release(f, {}, { host: { compatible: "1.4.0" } }),
    release(f, { "npm:pi-subagents": { source: { type: "npm", spec: "0.83.1" }, update: "fixed" } }),
    release(f, { "npm:pi-subagents": pin("0.83.1", "sha512-test") }),
    release(f, { "npm:pi-subagents": pin("0.83.1") }, { exceptions: [{ resource: "npm:pi-subagents", users: ["alice"], allow: "override" }] }),
    release(f, {}, { layer: "personal" }),
    release(f, {}, { unexpected: true }),
  ];
  for (const source of cases) {
    const result = f.run(["explain", "--layer", source, "--json"]);
    assert.equal(result.status, 1, result.stdout);
  }
  assert.deepEqual(f.commands(), []);
});

test("team exceptions are subject-specific, expire, and still require explicit override", (t) => {
  const f = fixture(t);
  const source = release(f, { "npm:pi-subagents": pin("0.83.1") }, {
    required: ["npm:pi-subagents"],
    exceptions: [{ resource: "npm:pi-subagents", users: ["alice"], machines: ["mac-dev"], allow: "override", expiresAt: "2999-01-01T00:00:00Z" }],
  });
  const override = personal(f, { "npm:pi-subagents": compatible("^0.84.0") }, { override: ["npm:pi-subagents"] });
  const allowed = f.run(["explain", "--layer", source, "--layer", override, "--user", "alice", "--machine", "mac-dev", "--json"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.data.resources[0].declaration.source.spec, "^0.84.0");
  assert.equal(payload.data.resources[0].required, true);
  assert.equal(payload.data.exceptions[0].state, "applied");
  for (const args of [[], ["--user", "alice"], ["--user", "bob", "--machine", "mac-dev"], ["--user", "alice", "--machine", "other"]]) {
    const blocked = f.run(["explain", "--layer", source, "--layer", override, ...args, "--json"]);
    assert.equal(blocked.status, 1, blocked.stdout);
  }
  const expired = release(f, { "npm:pi-subagents": pin("0.83.1") }, {
    required: ["npm:pi-subagents"],
    exceptions: [{ resource: "npm:pi-subagents", users: ["alice"], allow: "override", expiresAt: "2000-01-01T00:00:00Z" }],
  });
  assert.equal(f.run(["explain", "--layer", expired, "--layer", override, "--user", "alice", "--json"]).status, 1);
  const removal = personal(f, {}, { remove: ["npm:pi-subagents"] });
  assert.equal(f.run(["explain", "--layer", source, "--layer", removal, "--user", "alice", "--machine", "mac-dev", "--json"]).status, 1);
  const noExplicitOverride = personal(f, { "npm:pi-subagents": compatible("^0.84.0") });
  assert.equal(f.run(["explain", "--layer", source, "--layer", noExplicitOverride, "--user", "alice", "--machine", "mac-dev", "--json"]).status, 1);
});

test("resolver installs exact Release pins for current, changed, or missing packages without fallback", async (t) => {
  const f = fixture(t);
  install(f);
  const source = release(f, { "npm:pi-subagents": pin("0.83.1") }, { required: ["npm:pi-subagents"] });
  const bundle = loadBundle([source]);
  const report = await resolveConfiguration(context(f), bundle, [], metadata());
  assert.equal(report.ready, true);
  assert.equal(report.release.name, "team-2026-10");
  assert.equal(report.resources[0].action, "update");
  assert.equal(report.resources[0].releasePin, true);
  assert.equal(report.resources[0].targetVersion, "0.83.1");
  fs.rmSync(path.join(f.npmDir, "node_modules", "pi-subagents"), { recursive: true, force: true });
  const missing = await resolveConfiguration(context(f), bundle, [], metadata());
  assert.equal(missing.ready, true);
  assert.equal(missing.resources[0].currentVersion, null);
  assert.equal(missing.resources[0].action, "update");
  const wrongIntegrity = await resolveConfiguration(context(f), bundle, [], metadata({ pinIntegrity: OTHER_INTEGRITY }));
  assert.equal(wrongIntegrity.ready, false);
  assert.equal(wrongIntegrity.resources[0].action, "blocked");
  assert.equal(wrongIntegrity.resources[0].targetVersion, null);
  const incompatible = await resolveConfiguration(context(f), bundle, [], metadata({ peerRange: ">=2.0.0" }));
  assert.equal(incompatible.ready, false);
  assert.equal(incompatible.resources[0].action, "blocked");
});

test("Release host ranges retain a compatible current host and block when no compatible target exists", async (t) => {
  const f = fixture(t);
  const compatibleSource = release(f, {}, { host: { compatible: ">=1.2.0 <1.5.0" } });
  const compatibleReport = await resolveConfiguration(context(f), loadBundle([compatibleSource]), [], metadata());
  assert.equal(compatibleReport.host.action, "keep");
  assert.equal(compatibleReport.host.targetVersion, "1.4.0");
  assert.equal(compatibleReport.host.compatibleRange, ">=1.2.0 <1.5.0");
  const blockedSource = release(f, {}, { host: { compatible: ">=2.0.0 <3.0.0" } });
  const blockedReport = await resolveConfiguration(context(f), loadBundle([blockedSource]), [], metadata());
  assert.equal(blockedReport.host, null);
  assert.equal(blockedReport.ready, false);
  assert.match(blockedReport.errors[0].message, /outside/);
});

test("resolved update executes a Release pin and preserves the shared exact declaration", async (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  fs.rmSync(path.join(f.agentDir, "install", "releases", "1.5.0"), { recursive: true, force: true });
  install(f);
  manage(f);
  const manifestFile = path.join(f.npmDir, "package.json");
  const manifest = readJson(manifestFile);
  manifest.dependencies["pi-subagents"] = "0.83.1";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const source = release(f, { "npm:pi-subagents": pin("0.83.1") }, { required: ["npm:pi-subagents"] });
  const before = fs.readFileSync(source.slice(5), "utf8");
  const metadata = await metadataServer(t, { versions: { "0.83.1": { peers: { [HOST_PACKAGE]: ">=1.5.0" }, integrity: INTEGRITY } } });
  const result = f.run(["update", "--layer", source, "--json"], { ...metadata.env, MOCK_NPM_INTEGRITY: INTEGRITY });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.resolution.resources[0].releasePin, true);
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.1");
  assert.equal(readJson(manifestFile).dependencies["pi-subagents"], "0.83.1");
  assert.equal(fs.readFileSync(source.slice(5), "utf8"), before);
});
