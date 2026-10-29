import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext } from "../dist/context.js";
import { createMetadataClient } from "../dist/metadata.js";
import {
  assertTargetReleaseUnavailable,
  piArtifactEvidence,
  preparePiArtifacts,
  withVerifiedPiInstaller,
} from "../dist/pi-artifacts.js";
import { withOperationLock } from "../dist/state.js";
import { fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";
import { metadataServer } from "./metadata-server.mjs";

function context(f, env = f.env()) {
  return createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, env);
}

async function prepare(t, options = {}) {
  const f = fixture(t);
  const metadata = await metadataServer(t, options);
  return { f, metadata, context: context(f, f.env(metadata.env)) };
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

function personalLayer(f) {
  const file = path.join(f.root, "personal.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "personal",
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.83.0" }, update: "compatible" } },
  }));
  return `personal=${file}`;
}

test("reviewed installer binds every internal Pi package and serves identical bytes", async (t) => {
  const { context } = await prepare(t);
  const plan = await preparePiArtifacts(context, "1.5.0");
  assert.equal(plan.artifacts.length, PEERS.length + 1);
  const lock = JSON.parse(plan.packageLock);
  for (const artifact of plan.artifacts) {
    assert.equal(lock.packages[`node_modules/${artifact.name}`].integrity, artifact.integrity);
  }
  const evidence = piArtifactEvidence(plan);
  assert.equal(evidence.packageLockSha256, createHash("sha256").update(plan.packageLock).digest("hex"));
  assert.equal(JSON.stringify(evidence).includes(plan.packageLock), false);
  const base = await withVerifiedPiInstaller(plan, async (installerBase) => {
    const manifest = await fetch(`${installerBase}/1.5.0/package.json`);
    const lockResponse = await fetch(`${installerBase}/1.5.0/package-lock.json`);
    assert.equal(await manifest.text(), plan.packageJson);
    assert.equal(await lockResponse.text(), plan.packageLock);
    assert.equal((await fetch(`${installerBase}/other`)).status, 404);
    return installerBase;
  });
  await assert.rejects(fetch(`${base}/1.5.0/package.json`));
});

test("invalid installer identity and missing external integrity fail closed", async (t) => {
  const invalid = await prepare(t, { installerManifest: { name: "wrong", version: "1.5.0" } });
  await assert.rejects(preparePiArtifacts(invalid.context, "1.5.0"), /installer manifest/);
  const missing = await prepare(t, {
    installerLock: {
      lockfileVersion: 3,
      packages: {
        "": { name: "@earendil-works/pi-coding-agent-install", version: "1.5.0", dependencies: { [HOST_PACKAGE]: "1.5.0" } },
        "node_modules/left-pad": { version: "1.2.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.2.0.tgz" },
      },
    },
  });
  await assert.rejects(preparePiArtifacts(missing.context, "1.5.0"), /no valid registry integrity/);
});

test("registry tarball and integrity mismatches are rejected", async (t) => {
  const { context } = await prepare(t);
  const client = createMetadataClient({
    releaseUrl: context.env.AGENTBREW_PI_RELEASE_URL,
    registryUrl: context.env.AGENTBREW_NPM_REGISTRY_URL,
    installerUrl: context.env.AGENTBREW_PI_INSTALLER_URL,
  });
  const original = client.getManifest;
  client.getManifest = async (name, version) => {
    const value = await original(name, version);
    return { ...value, dist: { ...value.dist, tarball: "https://registry.npmjs.org/unexpected.tgz" } };
  };
  await assert.rejects(preparePiArtifacts(context, "1.5.0", client), /tarball URLs differ/);
  client.getManifest = async (name, version) => {
    const value = await original(name, version);
    return { ...value, dist: { ...value.dist, integrity: "sha512-invalid" } };
  };
  await assert.rejects(preparePiArtifacts(context, "1.5.0", client), /integrity/);
});

test("an existing target release cannot bypass artifact verification", async (t) => {
  const { f, metadata } = await prepare(t);
  f.setHost("1.5.0");
  assert.throws(() => assertTargetReleaseUnavailable(context(f), "1.5.0"), /already exists/);
  manage(f);
  const result = f.run(["update", "--layer", personalLayer(f), "--json"], metadata.env);
  assert.equal(result.status, 6, result.stderr || result.stdout);
  assert.match(JSON.parse(result.stdout).error, /already exists/);
  assert.equal(f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
});

test("artifact preparation failure blocks Pi, npm, and herdr execution", async (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  fs.rmSync(path.join(f.agentDir, "install", "releases", "1.5.0"), { recursive: true, force: true });
  manage(f);
  const metadata = await metadataServer(t, { installerManifest: { name: "invalid", version: "1.5.0" } });
  const result = f.run(["update", "--layer", personalLayer(f), "--json"], metadata.env);
  assert.equal(result.status, 6, result.stderr || result.stdout);
  assert.equal(f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install") || line.startsWith("herdr integration install")), false);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "install", "current-version"), "utf8").trim(), "1.4.0");
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "last-pi-install-plan.json")), false);
});

test("operation lock remains held through asynchronous work and releases afterward", async (t) => {
  const f = fixture(t);
  const pending = withOperationLock(context(f), async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return "done";
  });
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), true);
  assert.equal(await pending, "done");
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
});

test("real public Pi installer metadata matches the reviewed artifact contract", { skip: !process.env.AGENTBREW_TEST_NETWORK }, async (t) => {
  const f = fixture(t);
  const plan = await preparePiArtifacts(context(f, f.env({ HOME: f.home })), "1.4.0");
  assert.equal(plan.targetVersion, "1.4.0");
  assert.equal(plan.artifacts.some((artifact) => artifact.name === HOST_PACKAGE), true);
  assert.equal(JSON.parse(plan.packageJson).dependencies[HOST_PACKAGE], "1.4.0");
  assert.equal(fs.readFileSync(path.join(f.agentDir, "install", "current-version"), "utf8").trim(), "1.4.0");
});
