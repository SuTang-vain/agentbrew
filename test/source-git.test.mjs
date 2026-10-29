import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixture, HOST_PACKAGE, PEERS, readJson } from "./helpers.mjs";
import { metadataServer } from "./metadata-server.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Agentbrew Test",
      GIT_AUTHOR_EMAIL: "agentbrew@example.invalid",
      GIT_COMMITTER_NAME: "Agentbrew Test",
      GIT_COMMITTER_EMAIL: "agentbrew@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function teamValue(spec = "^0.83.0", required = []) {
  return {
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "team",
    resources: { "npm:pi-subagents": { source: { type: "npm", spec }, update: "compatible" } },
    ...(required.length ? { required } : {}),
  };
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrew-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(work);
  git(work, ["init", "--initial-branch=main"]);
  const file = path.join(work, "team.json");
  fs.writeFileSync(file, JSON.stringify(teamValue()));
  git(work, ["add", "team.json"]);
  git(work, ["commit", "-m", "initial team layer"]);
  git(root, ["clone", "--bare", work, remote]);
  git(work, ["remote", "add", "origin", remote]);
  return {
    root,
    remote,
    file,
    update(value) {
      fs.writeFileSync(file, JSON.stringify(value));
      git(work, ["add", "team.json"]);
      git(work, ["commit", "-m", "update team layer"]);
      git(work, ["push", "origin", "main"]);
    },
  };
}

function registration(f) {
  return readJson(path.join(f.stateDir, "sources.json"));
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

function prepareUpdate(f) {
  f.setHost("1.5.0");
  fs.rmSync(path.join(f.agentDir, "install", "releases", "1.5.0"), { recursive: true, force: true });
  const dir = path.join(f.npmDir, "node_modules", "pi-subagents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "pi-subagents",
    version: "0.83.0",
    peerDependencies: { [HOST_PACKAGE]: ">=1.2.0" },
  }));
  manage(f);
}

test("Git source set records an immutable commit and refresh advances only source state", async (t) => {
  const repo = repository(t);
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const input = `team=${repo.remote}#team.json`;
  const created = f.run(["source", "set", "--git", input, "--json"]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const initial = registration(f);
  assert.equal(initial.schemaVersion, 2);
  assert.match(initial.layers[0].git.commit, /^[0-9a-f]{40}$/);
  assert.equal(fs.existsSync(initial.layers[0].file), true);
  assert.equal(fs.statSync(initial.layers[0].file).mode & 0o777, 0o600);
  const listed = f.run(["source", "list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).data.layers[0].git.path, "team.json");

  repo.update(teamValue("^0.83.0", ["npm:pi-subagents"]));
  const refreshed = f.run(["source", "refresh", "--json"]);
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
  const advanced = registration(f);
  assert.notEqual(advanced.layers[0].git.commit, initial.layers[0].git.commit);
  assert.notEqual(advanced.layers[0].file, initial.layers[0].file);
  assert.equal(fs.existsSync(initial.layers[0].file), true);
  assert.equal(readJson(advanced.layers[0].file).required[0], "npm:pi-subagents");
  assert.equal(JSON.parse(refreshed.stdout).data.changes.length, 1);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  const unchanged = f.run(["source", "refresh", "--json"]);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.stdout.includes('"changes": "none"'), true);
});

test("dry-run keeps the cached commit while real update refreshes registered Git sources", async (t) => {
  const repo = repository(t);
  const f = fixture(t);
  prepareUpdate(f);
  const metadata = await metadataServer(t);
  assert.equal(f.run(["source", "set", "--git", `team=${repo.remote}#team.json`, "--json"]).status, 0);
  const initial = registration(f);
  repo.update(teamValue("^0.83.0", ["npm:pi-subagents"]));
  const dry = f.run(["update", "--dry-run", "--json"], metadata.env);
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.equal(JSON.parse(dry.stdout).data.sourceRefresh.state, "cached");
  assert.equal(JSON.parse(dry.stdout).data.sourceRefresh.command, "agentbrew source refresh");
  assert.equal(registration(f).layers[0].git.commit, initial.layers[0].git.commit);
  const updated = f.run(["update", "--json"], metadata.env);
  assert.equal(updated.status, 0, updated.stderr || updated.stdout);
  assert.notEqual(registration(f).layers[0].git.commit, initial.layers[0].git.commit);
  assert.equal(readJson(path.join(f.stateDir, "last-result.json")).status, "success");
});

test("offline refresh and update fail before advancing a Git binding", async (t) => {
  const repo = repository(t);
  const f = fixture(t);
  prepareUpdate(f);
  assert.equal(f.run(["source", "set", "--git", `team=${repo.remote}#team.json`, "--json"]).status, 0);
  const before = fs.readFileSync(path.join(f.stateDir, "sources.json"), "utf8");
  repo.update(teamValue("^0.83.0", ["npm:pi-subagents"]));
  const refreshed = f.run(["source", "refresh", "--json"], { PI_OFFLINE: "1" });
  assert.equal(refreshed.status, 6, refreshed.stderr || refreshed.stdout);
  assert.match(JSON.parse(refreshed.stdout).error, /PI_OFFLINE/);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "sources.json"), "utf8"), before);
  const updated = f.run(["update", "--json"], { PI_OFFLINE: "1" });
  assert.equal(updated.status, 6, updated.stderr || updated.stdout);
  assert.equal(fs.readFileSync(path.join(f.stateDir, "sources.json"), "utf8"), before);
  assert.equal(f.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
});

test("unsafe Git inputs and non-blob paths are rejected without a binding", async (t) => {
  const repo = repository(t);
  const f = fixture(t);
  const cases = [
    "team=https://user:pass@example.invalid/repo.git#team.json",
    "team=relative/repo.git#team.json",
    `team=${repo.remote}#../team.json`,
    `team=${repo.remote}#missing.json`,
  ];
  for (const input of cases) {
    const result = f.run(["source", "set", "--git", input, "--json"]);
    assert.equal(result.status, 6, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(f.stateDir, "sources.json")), false);
  }
});

test("damaged cache fails closed and does not affect another target", async (t) => {
  const repo = repository(t);
  const first = fixture(t);
  const second = fixture(t);
  const input = `team=${repo.remote}#team.json`;
  assert.equal(first.run(["source", "set", "--git", input, "--json"]).status, 0);
  assert.equal(second.run(["source", "set", "--git", input, "--json"]).status, 0);
  const one = registration(first);
  const two = registration(second);
  assert.notEqual(one.target.agentDir, two.target.agentDir);
  assert.notEqual(one.layers[0].file, two.layers[0].file);
  fs.writeFileSync(one.layers[0].file, "not json\n");
  assert.equal(first.run(["source", "list", "--json"]).status, 1);
  assert.equal(second.run(["source", "list", "--json"]).status, 0);
  const updated = first.run(["update", "--json"]);
  assert.equal(updated.status, 6, updated.stderr || updated.stdout);
  assert.equal(first.commands().some((line) => line.startsWith("pi update") || line.startsWith("npm install")), false);
});
