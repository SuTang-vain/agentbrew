import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";
import { metadataServer } from "./metadata-server.mjs";

function layer(f, spec = "^0.83.0", name = "personal") {
  const file = path.join(f.root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "personal",
    resources: { "npm:pi-subagents": { source: { type: "npm", spec }, update: "compatible" } },
  }, null, 2));
  return `personal=${file}`;
}

function prepare(t) {
  const f = fixture(t);
  f.setHost("1.5.0");
  fs.rmSync(path.join(f.agentDir, "install", "releases", "1.5.0"), { recursive: true, force: true });
  const dir = path.join(f.npmDir, "node_modules", "pi-subagents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "pi-subagents",
    version: "0.83.0",
    peerDependencies: { [HOST_PACKAGE]: ">=1.2.0" },
  }));
  const resources = {
    "pi.host": "manage",
    "pi.host-links": "manage",
    "herdr.pi-integration": "generate",
    ...Object.fromEntries([...PEERS, "pi-subagents"].map((name) => [`npm:${name}`, "manage"])),
  };
  fs.mkdirSync(f.stateDir, { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, "ownership.json"), JSON.stringify({ schemaVersion: 1, resources }));
  return f;
}

function sourceFile(f) {
  return path.join(f.stateDir, "sources.json");
}

test("source set/list registers explicit paths without executing providers or changing resources", async (t) => {
  const f = prepare(t);
  const input = layer(f);
  const manifestBefore = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const set = f.run(["source", "set", "--layer", input, "--json"]);
  assert.equal(set.status, 0, set.stderr);
  const payload = JSON.parse(set.stdout);
  assert.equal(payload.data.resourcesChanged, false);
  assert.equal(payload.data.registration.layers[0].file, input.slice(input.indexOf("=") + 1));
  assert.equal(fs.statSync(sourceFile(f)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), manifestBefore);
  assert.deepEqual(f.commands(), []);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);

  const list = f.run(["source", "list", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).data.state, "current");
  assert.deepEqual(f.commands(), []);
  fs.appendFileSync(input.slice(input.indexOf("=") + 1), "\n");
  const changed = f.run(["source", "--json"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).data.state, "changed");
});

test("registered sources drive dry-run, read-only commands, and real resolved update without repeated layers", async (t) => {
  const f = prepare(t);
  const input = layer(f);
  assert.equal(f.run(["source", "set", "--layer", input, "--json"]).status, 0);
  const metadata = await metadataServer(t);
  const dry = f.run(["update", "--dry-run", "--json"], metadata.env);
  assert.equal(dry.status, 0, dry.stderr);
  const preview = JSON.parse(dry.stdout);
  assert.equal(preview.data.layerOrigin, "registered");
  assert.equal(preview.data.resolvedMode, true);
  assert.equal(preview.data.resolution.resources[0].targetVersion, "0.83.1");

  const resolved = f.run(["resolve", "--json"], metadata.env);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(JSON.parse(resolved.stdout).data.layerOrigin, "registered");
  const diff = f.run(["diff", "--json"]);
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).data.layerOrigin, "registered");
  const doctor = f.run(["doctor", "--json"]);
  assert.equal(doctor.status, 4, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).data.layerOrigin, "registered");

  const updated = f.run(["update", "--json"], metadata.env);
  assert.equal(updated.status, 0, updated.stderr);
  const result = JSON.parse(updated.stdout);
  assert.equal(result.data.layerOrigin, "registered");
  assert.equal(readJson(path.join(f.stateDir, "last-result.json")).data.layerOrigin, "registered");
  assert.equal(result.data.resolution.resources[0].targetVersion, "0.83.1");
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.1");
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
});

test("an explicit layer overrides but never rewrites the registered binding", async (t) => {
  const f = prepare(t);
  const registered = layer(f);
  assert.equal(f.run(["source", "set", "--layer", registered, "--json"]).status, 0);
  const before = fs.readFileSync(sourceFile(f), "utf8");
  const alternate = layer(f, "^0.84.0", "alternate");
  const metadata = await metadataServer(t, {
    versions: {
      "0.83.0": { peers: { [HOST_PACKAGE]: ">=1.2.0" } },
      "0.83.1": { peers: { [HOST_PACKAGE]: ">=1.5.0" } },
      "0.84.0": { peers: { [HOST_PACKAGE]: ">=1.5.0" } },
    },
  });
  const result = f.run(["resolve", "--layer", alternate, "--json"], metadata.env);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.layerOrigin, "explicit");
  assert.equal(payload.data.resources[0].targetVersion, "0.84.0");
  assert.equal(fs.readFileSync(sourceFile(f), "utf8"), before);
});

test("damaged or missing registered sources never fall back to native update", async (t) => {
  const f = prepare(t);
  fs.writeFileSync(sourceFile(f), JSON.stringify({ schemaVersion: 1, kind: "agentbrew-source-registration", extra: true }));
  const update = f.run(["update", "--json"]);
  assert.equal(update.status, 6);
  assert.equal(JSON.parse(update.stdout).status, "not-executed");
  assert.equal(f.commands().some((line) => line.startsWith("pi ") || line.startsWith("npm ")), false);
  const doctor = f.run(["doctor", "--json"]);
  assert.equal(doctor.status, 1);
  assert.equal(f.commands().some((line) => line.startsWith("pi ") || line.startsWith("npm ")), false);
  const clear = f.run(["source", "clear", "--json"]);
  assert.equal(clear.status, 1);
  assert.equal(fs.existsSync(sourceFile(f)), true);

  const valid = layer(f);
  assert.equal(f.run(["source", "set", "--layer", valid, "--json"]).status, 0);
  fs.rmSync(valid.slice(valid.indexOf("=") + 1));
  const missing = f.run(["update", "--json"]);
  assert.equal(missing.status, 6);
  assert.equal(f.commands().some((line) => line.startsWith("pi ") || line.startsWith("npm ")), false);
  const listed = f.run(["source", "list", "--json"]);
  assert.equal(listed.status, 1);
  assert.equal(JSON.parse(listed.stdout).data.state, "error");
});

test("explicit layers bypass a damaged registration without modifying it", async (t) => {
  const f = prepare(t);
  fs.writeFileSync(sourceFile(f), "not json\n");
  const input = layer(f);
  const metadata = await metadataServer(t);
  const result = f.run(["update", "--layer", input, "--dry-run", "--json"], metadata.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.layerOrigin, "explicit");
  assert.equal(fs.readFileSync(sourceFile(f), "utf8"), "not json\n");
});

test("source binding changes during resolution invalidate the plan before host execution", async (t) => {
  const f = prepare(t);
  const input = layer(f);
  assert.equal(f.run(["source", "set", "--layer", input, "--json"]).status, 0);
  const metadata = await metadataServer(t, { appendOnPackument: sourceFile(f) });
  const result = f.run(["update", "--json"], metadata.env);
  assert.equal(result.status, 6, result.stderr);
  assert.match(JSON.parse(result.stdout).error, /changed during resolution/);
  assert.equal(f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
});

test("source set validates inputs and source clear alone restores the native path", async (t) => {
  const f = prepare(t);
  const invalid = f.run(["source", "set", "--layer", `personal=${path.join(f.root, "missing.json")}`, "--json"]);
  assert.equal(invalid.status, 6);
  assert.equal(fs.existsSync(sourceFile(f)), false);
  const input = layer(f);
  assert.equal(f.run(["source", "set", "--layer", input, "--json"]).status, 0);
  const clear = f.run(["source", "clear", "--json"]);
  assert.equal(clear.status, 0, clear.stderr);
  assert.equal(JSON.parse(clear.stdout).changes, "observed");
  assert.equal(fs.existsSync(sourceFile(f)), false);
  const native = f.run(["update", "--dry-run", "--json"]);
  assert.equal(native.status, 0, native.stderr);
  assert.equal(JSON.parse(native.stdout).data.nativeMode, true);
  assert.equal(JSON.parse(native.stdout).data.layerOrigin, undefined);
  const repeated = f.run(["source", "clear", "--json"]);
  assert.equal(repeated.status, 0);
  assert.equal(JSON.parse(repeated.stdout).changes, "none");
});

test("source mutations respect an existing target operation lock", async (t) => {
  const f = prepare(t);
  fs.writeFileSync(path.join(f.stateDir, "operation.lock"), "held\n");
  const set = f.run(["source", "set", "--layer", layer(f), "--json"]);
  assert.equal(set.status, 1);
  assert.equal(fs.existsSync(sourceFile(f)), false);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "operation.lock"), "utf8"), "held\n");
  fs.rmSync(path.join(f.stateDir, "operation.lock"));
  assert.equal(f.run(["source", "set", "--layer", layer(f), "--json"]).status, 0);
  fs.writeFileSync(path.join(f.stateDir, "operation.lock"), "held\n");
  const clear = f.run(["source", "clear", "--json"]);
  assert.equal(clear.status, 1);
  assert.equal(fs.existsSync(sourceFile(f)), true);
});

test("source bindings are isolated by target and reject cross-target copies", (t) => {
  const first = prepare(t);
  const second = prepare(t);
  assert.equal(first.run(["source", "set", "--layer", layer(first), "--json"]).status, 0);
  const empty = second.run(["source", "list", "--json"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).data.registered, false);
  fs.copyFileSync(sourceFile(first), sourceFile(second));
  const copied = second.run(["source", "list", "--json"]);
  assert.equal(copied.status, 1);
  assert.match(JSON.parse(copied.stdout).error, /different Pi target/);
  const update = second.run(["update", "--json"]);
  assert.equal(update.status, 6);
  assert.equal(second.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
});
