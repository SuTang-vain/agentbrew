import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { CLI, fixture, HOST_PACKAGE } from "./helpers.mjs";

function run(f, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: f.env(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function server(t, { release = "1.5.0", peers = { [HOST_PACKAGE]: ">=1.2.0" }, fail = false } = {}) {
  const requests = [];
  const instance = http.createServer((request, response) => {
    requests.push(request.url);
    if (fail) {
      response.writeHead(500).end("token=server-secret");
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    response.setHeader("content-type", "application/json");
    if (pathname === "/release") {
      response.end(JSON.stringify({ version: release }));
      return;
    }
    if (pathname === `/${HOST_PACKAGE}/${release}`) {
      response.end(JSON.stringify({
        name: HOST_PACKAGE,
        version: release,
        dependencies: { "@earendil-works/pi-ai": release },
        dist: { integrity: "sha512-host" },
      }));
      return;
    }
    if (pathname === "/pi-subagents") {
      response.end(JSON.stringify({
        name: "pi-subagents",
        versions: {
          "0.83.0": { name: "pi-subagents", version: "0.83.0", peerDependencies: peers, dist: { integrity: "sha512-old" } },
          "0.83.1": { name: "pi-subagents", version: "0.83.1", peerDependencies: peers, dist: { integrity: "sha512-new" } },
        },
      }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => instance.close(resolve)));
  const address = instance.address();
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

function prepare(f, peers = { [HOST_PACKAGE]: ">=1.2.0" }) {
  const layer = path.join(f.root, "resolve-layer.json");
  fs.writeFileSync(layer, JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "personal",
    resources: { "npm:pi-subagents": { source: { type: "npm", spec: "^0.83.0" }, update: "compatible" } },
  }));
  const installed = path.join(f.npmDir, "node_modules", "pi-subagents");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "pi-subagents", version: "0.83.0", peerDependencies: peers }));
  return layer;
}

function env(meta) {
  return { AGENTBREW_PI_RELEASE_URL: `${meta.origin}/release`, AGENTBREW_NPM_REGISTRY_URL: meta.origin };
}

test("resolve CLI returns structured host and extension evidence without writes", async (t) => {
  const f = fixture(t);
  const layer = prepare(f);
  const meta = await server(t);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const result = await run(f, ["resolve", "--layer", `personal=${layer}`, "--json"], env(meta));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "resolve");
  assert.equal(payload.data.ready, true);
  assert.equal(payload.data.host.targetVersion, "1.5.0");
  assert.equal(payload.data.resources[0].targetVersion, "0.83.1");
  assert.equal(payload.data.resources[0].integrity, "sha512-new");
  assert.equal(payload.changes, "none");
  assert.equal(result.stdout.includes("\u001b"), false);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.deepEqual(f.commands(), []);
  const verbose = await run(f, ["resolve", "--layer", `personal=${layer}`, "--verbose"], env(meta));
  assert.equal(verbose.status, 0, verbose.stderr);
  assert.match(verbose.stdout, /RESOLVE npm:pi-subagents 0.83.0 -> 0.83.1 \(update\)/);
  assert.match(verbose.stdout, /PEER @earendil-works\/pi-coding-agent >=1.2.0 against 1.5.0: true/);
  assert.match(verbose.stdout, /integrity: sha512-new/);
});

test("resolve offline makes no request and creates no state", async (t) => {
  const f = fixture(t);
  const layer = prepare(f);
  const meta = await server(t);
  const result = await run(f, ["resolve", "--layer", `personal=${layer}`, "--json"], { ...env(meta), PI_OFFLINE: "1" });
  assert.equal(result.status, 6);
  assert.match(JSON.parse(result.stdout).error, /PI_OFFLINE/);
  assert.equal(meta.requests.length, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("unknown peer metadata keeps a successful diagnosis but blocks host updates", async (t) => {
  const f = fixture(t);
  const layer = prepare(f, {});
  const meta = await server(t, { peers: {} });
  const result = await run(f, ["resolve", "--layer", `personal=${layer}`, "--json"], env(meta));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.ready, false);
  assert.equal(payload.data.complete, false);
  assert.equal(payload.data.resources[0].action, "unknown");
  assert.match(payload.error, /must remain blocked/);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("metadata HTTP errors fail without leaking response bodies", async (t) => {
  const f = fixture(t);
  const layer = prepare(f);
  const meta = await server(t, { fail: true });
  const result = await run(f, ["resolve", "--layer", `personal=${layer}`, "--json"], env(meta));
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes("server-secret"), false);
  assert.equal(result.stderr.includes("server-secret"), false);
  assert.equal(JSON.parse(result.stdout).status, "failed");
});

test("resolve requires a layer before making network requests", async (t) => {
  const f = fixture(t);
  const meta = await server(t);
  const result = await run(f, ["resolve", "--json"], env(meta));
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /requires at least one/);
  assert.equal(meta.requests.length, 0);
});
