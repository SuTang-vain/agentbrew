import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createContext } from "../dist/context.js";
import { runTui } from "../dist/tui.js";
import { CLI, fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";
import { metadataServer } from "./metadata-server.mjs";

const INTEGRITY = `sha512-${Buffer.alloc(64, 21).toString("base64")}`;

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

function prepareTarget(f, spec, current = "0.83.0") {
  f.setHost("1.5.0");
  fs.rmSync(path.join(f.agentDir, "install", "releases", "1.5.0"), { recursive: true, force: true });
  if (current) {
    const dir = path.join(f.npmDir, "node_modules", "pi-subagents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "pi-subagents",
      version: current,
      peerDependencies: { [HOST_PACKAGE]: ">=1.2.0" },
    }));
  }
  const manifestFile = path.join(f.npmDir, "package.json");
  const manifest = readJson(manifestFile);
  manifest.dependencies["pi-subagents"] = spec;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  manage(f);
}

function layer(f, kind, value, release = false) {
  const file = path.join(f.root, `${kind}-e2e.json`);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    kind: release ? "agentbrew-release" : "agentbrew-layer",
    layer: kind,
    ...(release ? { release: "e2e-team-1" } : {}),
    ...value,
  }));
  return `${kind}=${file}`;
}

function runAsync(f, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: f.env(env), encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function tuiSession() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  output.on("data", (chunk) => { text += chunk.toString(); });
  return {
    input,
    output,
    streams: { input, output, error: output, interactive: true, env: { TERM: "xterm-256color", NO_COLOR: "1" } },
    text: () => text,
  };
}

async function waitFor(session, pattern) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (pattern.test(session.text())) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`TUI did not render ${pattern}: ${session.text()}`);
}

test("a healthy team update publishes a Release that installs exactly on another target", async (t) => {
  const first = fixture(t);
  prepareTarget(first, "^0.83.0");
  const source = layer(first, "team", {
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.83.0" }, update: "compatible" } },
    required: ["npm:pi-subagents"],
  });
  const metadata = await metadataServer(t, {
    versions: { "0.83.1": { peers: { [HOST_PACKAGE]: ">=1.5.0" }, integrity: INTEGRITY } },
  });
  const updated = first.run(["update", "--layer", source, "--json"], { ...metadata.env, MOCK_NPM_INTEGRITY: INTEGRITY });
  assert.equal(updated.status, 0, updated.stderr || updated.stdout);
  const output = path.join(first.root, "team-release.json");
  const published = first.run(["release", "create", "--layer", source, "--output", output, "--json"]);
  assert.equal(published.status, 0, published.stderr || published.stdout);
  const release = readJson(output);
  assert.equal(release.resources["npm:pi-subagents"].source.spec, "0.83.1");
  assert.equal(release.verification.runtimeLoad, "unknown");

  const second = fixture(t);
  prepareTarget(second, "0.83.1", null);
  const before = fs.readFileSync(output, "utf8");
  const installed = second.run(["update", "--layer", `team=${output}`, "--json"], { ...metadata.env, MOCK_NPM_INTEGRITY: INTEGRITY });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(readJson(path.join(second.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.1");
  assert.equal(readJson(path.join(second.npmDir, "package.json")).dependencies["pi-subagents"], "0.83.1");
  assert.equal(fs.readFileSync(output, "utf8"), before);
  assert.notEqual(readJson(path.join(first.stateDir, "last-result.json")).target.agentDir, readJson(path.join(second.stateDir, "last-result.json")).target.agentDir);
});

test("the real TUI previews, confirms, applies, and restores the terminal without operation doubles", async (t) => {
  const f = fixture(t);
  prepareTarget(f, "^0.83.0");
  const source = layer(f, "personal", {
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.83.0" }, update: "compatible" } },
  });
  const metadata = await metadataServer(t);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir, layers: [source] }, f.env(metadata.env));
  const session = tuiSession();
  const status = runTui(context, session.streams, {}, { write: true });
  await waitFor(session, /Status\s+repairable/);
  session.input.write("4");
  await waitFor(session, /u apply/);
  session.input.write("u");
  await waitFor(session, /Apply update\?/);
  session.input.write("\x1b[A\r");
  await waitFor(session, /Update result/);
  session.input.write("q");
  assert.equal(await status, 0);
  assert.equal(readJson(path.join(f.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.1");
  assert.equal(fs.readFileSync(path.join(f.agentDir, "install", "current-version"), "utf8").trim(), "1.5.0");
  assert.match(session.text(), /Agentbrew closed · last update: success/);
  assert.equal(session.input.isRaw, false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "operation.lock")), false);
});

test("two targets with default per-user state update concurrently without sharing results or locks", async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  prepareTarget(first, "^0.83.0");
  prepareTarget(second, "^0.84.0");
  const firstSource = layer(first, "personal", {
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.83.0" }, update: "compatible" } },
  });
  const secondSource = layer(second, "personal", {
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.84.0" }, update: "compatible" } },
  });
  for (const f of [first, second]) {
    const key = createHash("sha256").update(f.agentDir).digest("hex").slice(0, 16);
    const defaultState = path.join(f.home, ".local", "state", "agentbrew", key);
    fs.mkdirSync(defaultState, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(f.stateDir, "ownership.json"), path.join(defaultState, "ownership.json"));
  }
  const metadata = await metadataServer(t, {
    versions: {
      "0.83.0": { peers: { [HOST_PACKAGE]: ">=1.2.0" } },
      "0.83.1": { peers: { [HOST_PACKAGE]: ">=1.5.0" } },
      "0.84.0": { peers: { [HOST_PACKAGE]: ">=1.5.0" } },
    },
  });
  const [one, two] = await Promise.all([
    runAsync(first, ["update", "--layer", firstSource, "--json"], { ...metadata.env, AGENTBREW_STATE_DIR: undefined }),
    runAsync(second, ["update", "--layer", secondSource, "--json"], { ...metadata.env, AGENTBREW_STATE_DIR: undefined }),
  ]);
  assert.equal(one.status, 0, one.stderr || one.stdout);
  assert.equal(two.status, 0, two.stderr || two.stdout);
  const firstTarget = JSON.parse(one.stdout).target.agentDir;
  const secondTarget = JSON.parse(two.stdout).target.agentDir;
  assert.notEqual(firstTarget, secondTarget);
  const stateFor = (home, target) => path.join(home, ".local", "state", "agentbrew", createHash("sha256").update(target).digest("hex").slice(0, 16));
  const firstState = stateFor(first.home, firstTarget);
  const secondState = stateFor(second.home, secondTarget);
  assert.notEqual(firstState, secondState);
  assert.equal(readJson(path.join(firstState, "last-result.json")).status, "success");
  assert.equal(readJson(path.join(secondState, "last-result.json")).status, "success");
  assert.equal(readJson(path.join(first.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.83.1");
  assert.equal(readJson(path.join(second.npmDir, "node_modules", "pi-subagents", "package.json")).version, "0.84.0");
  assert.equal(fs.existsSync(path.join(firstState, "operation.lock")), false);
  assert.equal(fs.existsSync(path.join(secondState, "operation.lock")), false);
});
