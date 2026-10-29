import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";
import { metadataServer } from "./metadata-server.mjs";

function install(f, version = "0.83.0", peers = { [HOST_PACKAGE]: ">=1.2.0" }, name = "pi-subagents") {
  const dir = path.join(f.npmDir, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, peerDependencies: peers }));
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

function layer(f, spec = "^0.83.0", update = "compatible") {
  const file = path.join(f.root, "personal.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "personal",
    resources: { "npm:pi-subagents": { source: { type: "npm", spec }, update } },
  }, null, 2));
  return `personal=${file}`;
}

async function prepare(t, options = {}) {
  const f = fixture(t, { realNpm: options.realNpm === true });
  f.setHost("1.5.0");
  install(f, options.current ?? "0.83.0", options.peers);
  const manifestFile = path.join(f.npmDir, "package.json");
  const manifest = readJson(manifestFile);
  manifest.dependencies["pi-subagents"] = options.spec ?? "^0.83.0";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  manage(f);
  const source = options.source ?? layer(f, options.spec, options.policy);
  const metadata = await metadataServer(t, options.metadata);
  return { f, source, metadata, args: ["update", "--layer", source, "--json"] };
}

test("resolved dry-run shows exact targets without commands, writes, or locks", async (t) => {
  const { f, args, source } = await prepare(t);
  const manifestBefore = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const layerBefore = fs.readFileSync(source.slice(source.indexOf("=") + 1), "utf8");
  const result = f.run([...args.slice(0, -1), "--dry-run", "--json"], { ...(await metadataServer(t)).env, PI_OFFLINE: "1" });
  assert.equal(result.status, 6, result.stderr);
  assert.match(result.stdout, /PI_OFFLINE/);
  assert.equal(f.commands().some((line) => line.startsWith("pi ") || line.startsWith("npm ")), false);

  const meta = await metadataServer(t);
  const dry = f.run([...args.slice(0, -1), "--dry-run", "--json"], meta.env);
  assert.equal(dry.status, 0, dry.stderr);
  const payload = JSON.parse(dry.stdout);
  assert.equal(payload.data.resolution.host.targetVersion, "1.5.0");
  assert.equal(payload.data.resolution.resources[0].targetVersion, "0.83.1");
  assert.equal(payload.changes, "none");
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), manifestBefore);
  assert.equal(fs.readFileSync(source.slice(source.indexOf("=") + 1), "utf8"), layerBefore);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "last-result.json")), false);
  assert.equal(f.commands().some((line) => line.startsWith("pi ") || line.startsWith("npm ")), false);
});

test("resolved update executes host first, installs exact packages, and preserves shared intent", async (t) => {
  const { f, args, source, metadata } = await prepare(t);
  const layerFile = source.slice(source.indexOf("=") + 1);
  const layerBefore = fs.readFileSync(layerFile, "utf8");
  const result = f.run(args, metadata.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "success");
  assert.equal(payload.data.resolution.resources[0].integrity, "sha512-0.83.1");
  assert.equal(fs.readFileSync(path.join(f.agentDir, "install", "current-version"), "utf8").trim(), "1.5.0");
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.1");
  assert.equal(readJson(path.join(f.npmDir, "package.json")).dependencies["pi-subagents"], "^0.83.0");
  assert.equal(fs.readFileSync(layerFile, "utf8"), layerBefore);
  const commands = f.commands();
  assert.equal(commands.includes("pi update --all"), false);
  const prepareCommand = commands.indexOf("npm install --package-lock-only --ignore-scripts --legacy-peer-deps");
  const installCommand = commands.indexOf("npm install --ignore-scripts --legacy-peer-deps");
  assert.ok(commands.indexOf("pi update --self") < prepareCommand);
  assert.ok(prepareCommand < installCommand);
  assert.equal(commands.some((command) => command.includes("--no-save")), false);
  assert.equal(commands[commands.indexOf("pi update --self") + 1], "pi --version");
  assert.equal(readJson(path.join(f.npmDir, "package-lock.json")).packages["node_modules/pi-subagents"].version, "0.83.1");
  assert.equal(readJson(path.join(f.npmDir, "package-lock.json")).packages[""].dependencies["pi-subagents"], "^0.83.0");
  assert.equal(readJson(path.join(f.stateDir, "last-install-plan.json")).resources[0].version, "0.83.1");
  assert.equal(fs.readdirSync(f.stateDir).some((name) => name.startsWith(".npm-plan-")), false);
  assert.equal(readJson(path.join(f.stateDir, "last-resolution.json")).report.host.targetVersion, "1.5.0");
  assert.equal(readJson(path.join(f.stateDir, "last-result.json")).status, "success");
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
  assert.equal(fs.realpathSync(path.join(f.npmDir, "host-link")), fs.realpathSync(path.join(f.agentDir, "install", "releases", "1.5.0", "node_modules", HOST_PACKAGE)));
});

test("npm rewriting lock formatting or dependency order does not fail the reviewed plan", async (t) => {
  const { f, args, metadata } = await prepare(t);
  const result = f.run(args, { ...metadata.env, MOCK_NPM_REORDER_LOCK: "1" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.steps.find((step) => step.id === "npm-install").status, "success");
  const lock = readJson(path.join(f.npmDir, "package-lock.json"));
  const expected = [HOST_PACKAGE, ...PEERS, "pi-subagents"].sort();
  assert.deepEqual(Object.keys(lock.packages[""].dependencies).sort(), expected);
  assert.equal(lock.packages["node_modules/pi-subagents"].version, "0.83.1");
  const reviewed = readJson(path.join(f.stateDir, "last-package-lock.plan.json"));
  assert.deepEqual(Object.keys(reviewed.packages[""].dependencies).sort(), expected);
});

test("host command failure and unexpected host versions block every extension", async (t) => {
  const failure = await prepare(t);
  const failed = failure.f.run(failure.args, { ...failure.metadata.env, MOCK_PI_FAIL: "1" });
  assert.equal(failed.status, 3);
  assert.equal(JSON.parse(failed.stdout).status, "partial");
  assert.equal(failure.f.commands().includes("pi update --self"), true);
  assert.equal(failure.f.commands().some((line) => line.startsWith("npm install")), false);
  assert.equal(failure.f.commands().includes("herdr integration install pi"), false);
  assert.equal(fs.existsSync(path.join(failure.f.stateDir, "operation.lock")), false);

  const mismatch = await prepare(t);
  mismatch.f.setHost("1.6.0");
  const wrong = mismatch.f.run(mismatch.args, { ...mismatch.metadata.env, MOCK_NEXT_VERSION: "1.6.0" });
  assert.equal(wrong.status, 3);
  assert.match(JSON.stringify(wrong.stdout), /resolved plan requires 1.5.0/);
  assert.equal(mismatch.f.commands().some((line) => line.startsWith("npm install")), false);

  const reported = await prepare(t);
  const wrongReport = reported.f.run(reported.args, { ...reported.metadata.env, MOCK_PI_REPORTED_VERSION: "1.4.0" });
  assert.equal(wrongReport.status, 3);
  assert.match(JSON.stringify(wrongReport.stdout), /pi --version reports 1.4.0/);
  assert.equal(reported.f.commands().some((line) => line.startsWith("npm install")), false);
});

test("fixed and manual packages remain installed without native bulk update", async (t) => {
  for (const policy of ["fixed", "manual"]) {
    const { f, args, metadata } = await prepare(t, { spec: "0.83.0", policy, metadata: { release: "1.4.0" } });
    const result = f.run(args, metadata.env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).data.resolution.resources[0].action, "keep");
    assert.equal(f.commands().includes("pi update --self"), false);
    assert.equal(f.commands().includes("npm install --package-lock-only --ignore-scripts --legacy-peer-deps"), true);
    assert.equal(f.commands().some((line) => line.includes("--no-save")), false);
    assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.0");
    assert.equal(readJson(path.join(f.npmDir, "package-lock.json")).packages["node_modules/pi-subagents"].version, "0.83.0");
  }
});

test("the complete lock plan retains a fixed direct dependency while another package updates", async (t) => {
  const { f, args, source, metadata } = await prepare(t);
  const layerFile = source.slice(source.indexOf("=") + 1);
  const declaration = readJson(layerFile);
  declaration.resources["npm:left-pad"] = { source: { type: "npm", spec: "1.2.0" }, update: "fixed" };
  fs.writeFileSync(layerFile, JSON.stringify(declaration));
  const manifestFile = path.join(f.npmDir, "package.json");
  const manifest = readJson(manifestFile);
  manifest.dependencies["left-pad"] = "1.2.0";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const ownershipFile = path.join(f.stateDir, "ownership.json");
  const ownership = readJson(ownershipFile);
  ownership.resources["npm:left-pad"] = "manage";
  fs.writeFileSync(ownershipFile, JSON.stringify(ownership));
  install(f, "1.2.0", { [HOST_PACKAGE]: ">=1.2.0" }, "left-pad");
  const result = f.run(args, metadata.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lock = readJson(path.join(f.npmDir, "package-lock.json"));
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.1");
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "left-pad", "package.json")).version, "1.2.0");
  assert.equal(lock.packages["node_modules/pi-subagents"].version, "0.83.1");
  assert.equal(lock.packages["node_modules/left-pad"].version, "1.2.0");
  assert.equal(lock.packages[""].dependencies["left-pad"], "1.2.0");
  assert.equal(readJson(manifestFile).dependencies["left-pad"], "1.2.0");
});

test("unknown compatibility blocks host changes and is partial when retaining with a stable host", async (t) => {
  const blocked = await prepare(t, { spec: "0.83.0", policy: "fixed", peers: {} });
  const result = blocked.f.run(blocked.args, blocked.metadata.env);
  assert.equal(result.status, 6);
  assert.equal(JSON.parse(result.stdout).data.resolution.ready, false);
  assert.equal(blocked.f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
  assert.equal(fs.existsSync(path.join(blocked.f.stateDir, "last-result.json")), false);

  const retained = await prepare(t, {
    peers: {},
    metadata: { release: "1.4.0", versions: { "0.83.0": { peers: {} } } },
  });
  const partial = retained.f.run(retained.args, retained.metadata.env);
  assert.equal(partial.status, 3, partial.stderr);
  const payload = JSON.parse(partial.stdout);
  assert.equal(payload.status, "partial");
  assert.equal(payload.data.resolution.resources[0].action, "unknown");
  assert.equal(payload.steps.some((step) => step.id === "npm-retain:npm:pi-subagents" && step.status === "skipped"), true);
  assert.equal(retained.f.commands().some((line) => line.startsWith("pi update")), false);
  assert.equal(readJson(path.join(retained.f.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.0");
  assert.equal(readJson(path.join(retained.f.npmDir, "package-lock.json")).packages["node_modules/pi-subagents"].version, "0.83.0");
});

test("metadata errors and incomplete Bundle coverage stop before host execution", async (t) => {
  const failure = await prepare(t, { metadata: { failure: true } });
  const failed = failure.f.run(failure.args, failure.metadata.env);
  assert.equal(failed.status, 6);
  assert.equal(failure.f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);

  const extra = await prepare(t);
  const manifestFile = path.join(extra.f.npmDir, "package.json");
  const manifest = readJson(manifestFile);
  manifest.dependencies["left-pad"] = "^1.3.0";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const ownership = readJson(path.join(extra.f.stateDir, "ownership.json"));
  ownership.resources["npm:left-pad"] = "manage";
  fs.writeFileSync(path.join(extra.f.stateDir, "ownership.json"), JSON.stringify(ownership));
  const incomplete = extra.f.run(extra.args, extra.metadata.env);
  assert.equal(incomplete.status, 6);
  assert.match(JSON.parse(incomplete.stdout).error, /no active Bundle declaration/);
  assert.equal(extra.f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
});

test("source changes during metadata resolution invalidate the plan inside the lock", async (t) => {
  const f = fixture(t);
  f.setHost("1.5.0");
  install(f);
  manage(f);
  const source = layer(f);
  const file = source.slice(source.indexOf("=") + 1);
  const metadata = await metadataServer(t, { appendOnPackument: file });
  const result = f.run(["update", "--layer", source, "--json"], metadata.env);
  assert.equal(result.status, 6, result.stderr);
  assert.match(JSON.parse(result.stdout).error, /changed during resolution/);
  assert.equal(f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "last-resolution.json")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
});

test("non-managed hosts refuse a planned host update before Pi or npm execution", async (t) => {
  const { f, args, metadata } = await prepare(t);
  const source = path.join(f.agentDir, "install", "releases", "1.4.0", "node_modules", "@earendil-works");
  const host = path.join(f.root, "path-host", "node_modules", "@earendil-works");
  fs.mkdirSync(path.dirname(host), { recursive: true });
  fs.cpSync(source, host, { recursive: true });
  const executable = path.join(host, path.basename(HOST_PACKAGE), "bin", "pi");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const pathBin = path.join(f.root, "path-bin");
  fs.mkdirSync(pathBin);
  fs.symlinkSync(executable, path.join(pathBin, "pi"));
  fs.rmSync(path.join(f.agentDir, "install", "current-version"));
  const result = f.run(args, { ...metadata.env, PATH: `${pathBin}${path.delimiter}${f.bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.status, 6, result.stderr);
  assert.match(JSON.parse(result.stdout).error, /managed installation/);
  assert.equal(f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
});

test("new target host dependencies are derived and superseded declarations are removed", async (t) => {
  const added = "@earendil-works/pi-codemode";
  const removed = "@earendil-works/pi-mcp";
  const names = [...PEERS.filter((name) => name !== removed), added];
  const { f, args, metadata } = await prepare(t, { metadata: { hostDependencies: Object.fromEntries(names.map((name) => [name, "1.5.0"])) } });
  const scope = path.join(f.agentDir, "install", "releases", "1.5.0", "node_modules", "@earendil-works");
  const hostFile = path.join(scope, path.basename(HOST_PACKAGE), "package.json");
  const host = readJson(hostFile);
  delete host.dependencies[removed];
  host.dependencies[added] = "1.5.0";
  fs.writeFileSync(hostFile, JSON.stringify(host));
  fs.rmSync(path.join(scope, path.basename(removed)), { recursive: true });
  fs.mkdirSync(path.join(scope, path.basename(added)), { recursive: true });
  fs.writeFileSync(path.join(scope, path.basename(added), "package.json"), JSON.stringify({ name: added, version: "1.5.0" }));
  const result = f.run(args, metadata.env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = readJson(path.join(f.npmDir, "package.json"));
  assert.equal(manifest.dependencies[removed], undefined);
  assert.equal(manifest.dependencies[added], "file:host-deps/pi-codemode");
  assert.equal(fs.realpathSync(path.join(f.npmDir, "node_modules", added)), fs.realpathSync(path.join(scope, path.basename(added))));
});

test("npm may normalize lock key order without changing the reviewed content", async (t) => {
  const { f, args, metadata } = await prepare(t);
  const result = f.run(args, { ...metadata.env, MOCK_NPM_REORDER_LOCK: "1" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lock = readJson(path.join(f.npmDir, "package-lock.json"));
  assert.equal(lock.packages["node_modules/pi-subagents"].version, "0.83.1");
  assert.equal(lock.packages[""].dependencies["pi-subagents"], "^0.83.0");
});

test("npm failures and post-install verification failures stop dependent work and release locks", async (t) => {
  for (const environment of [{ MOCK_NPM_FAIL: "1" }, { MOCK_NPM_WRONG_VERSION: "1" }, { MOCK_NPM_REWRITE_MANIFEST: "1" }, { MOCK_NPM_BREAK_HOST_LINK: "1" }, { MOCK_NPM_REWRITE_LOCK: "1" }]) {
    const { f, args, metadata } = await prepare(t);
    const result = f.run(args, { ...metadata.env, ...environment });
    assert.equal(result.status, 3, `${JSON.stringify(environment)}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.steps.find((step) => step.id === "npm-install").status, "failed");
    assert.equal(f.commands().includes("herdr integration install pi"), false);
    assert.equal(f.commands().includes("npm run selftest"), false);
    assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
    assert.equal(readJson(path.join(f.stateDir, "last-result.json")).status, "partial");
  }
});

test("lock integrity mismatch stops before changing the target npm configuration", async (t) => {
  const { f, args, metadata } = await prepare(t);
  const result = f.run(args, { ...metadata.env, MOCK_NPM_WRONG_INTEGRITY: "1" });
  assert.equal(result.status, 3, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.steps.find((step) => step.id === "npm-install").message, /locked integrity differs/);
  assert.equal(fs.existsSync(path.join(f.npmDir, "package-lock.json")), false);
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.0");
  assert.equal(fs.existsSync(path.join(f.stateDir, "last-install-plan.json")), false);
  assert.equal(f.commands().includes("herdr integration install pi"), false);
  assert.equal(fs.readdirSync(f.stateDir).some((name) => name.startsWith(".npm-plan-")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
});

test("selftest remains opt-in and its failure is not a healthy update", async (t) => {
  const { f, args, metadata } = await prepare(t);
  const result = f.run([...args.slice(0, -1), "--selftest", "--json"], { ...metadata.env, MOCK_SELFTEST_FAIL: "1" });
  assert.equal(result.status, 3, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.steps.at(-1).id, "selftest");
  assert.equal(payload.steps.at(-1).status, "failed");
  assert.equal(f.commands().includes("npm run selftest"), true);
});

test("real npm installs the exact resolved registry package without rewriting declarations", { skip: !process.env.AGENTBREW_TEST_NETWORK }, async (t) => {
  const { f, args } = await prepare(t, { realNpm: true });
  const result = f.run(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const resolved = payload.data.resolution.resources.find((resource) => resource.id === "npm:pi-subagents");
  const lock = readJson(path.join(f.npmDir, "package-lock.json"));
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, resolved.targetVersion);
  assert.equal(lock.packages["node_modules/pi-subagents"].version, resolved.targetVersion);
  assert.equal(lock.packages["node_modules/pi-subagents"].integrity, resolved.integrity);
  const manifest = readJson(path.join(f.npmDir, "package.json"));
  assert.equal(manifest.dependencies["pi-subagents"], "^0.83.0");
  assert.equal(manifest.dependencies[HOST_PACKAGE], "file:host-link");
  assert.equal(lock.packages[""].dependencies["pi-subagents"], "^0.83.0");
});

test("real npm does not advance a fixed direct dependency while updating another package", { skip: !process.env.AGENTBREW_TEST_NETWORK }, async (t) => {
  const { f, args, source } = await prepare(t, { realNpm: true });
  const layerFile = source.slice(source.indexOf("=") + 1);
  const declaration = readJson(layerFile);
  declaration.resources["npm:left-pad"] = { source: { type: "npm", spec: "1.2.0" }, update: "fixed" };
  fs.writeFileSync(layerFile, JSON.stringify(declaration));
  const manifestFile = path.join(f.npmDir, "package.json");
  const manifest = readJson(manifestFile);
  manifest.dependencies["left-pad"] = "1.2.0";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const ownershipFile = path.join(f.stateDir, "ownership.json");
  const ownership = readJson(ownershipFile);
  ownership.resources["npm:left-pad"] = "manage";
  fs.writeFileSync(ownershipFile, JSON.stringify(ownership));
  install(f, "1.2.0", { [HOST_PACKAGE]: ">=1.2.0" }, "left-pad");
  const result = f.run(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const resolved = payload.data.resolution.resources.find((resource) => resource.id === "npm:pi-subagents");
  const lock = readJson(path.join(f.npmDir, "package-lock.json"));
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, resolved.targetVersion);
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "left-pad", "package.json")).version, "1.2.0");
  assert.equal(lock.packages["node_modules/left-pad"].version, "1.2.0");
  assert.equal(readJson(manifestFile).dependencies["left-pad"], "1.2.0");
});
