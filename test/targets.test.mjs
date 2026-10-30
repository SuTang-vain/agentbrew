import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext } from "../dist/context.js";
import { checkTarget } from "../dist/targets.js";
import { fixture, readJson } from "./helpers.mjs";

function registry(f, targets) {
  const file = path.join(f.root, "targets.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: "agentbrew-targets", targets }, null, 2));
  return file;
}

function remote(id, destination = `${id}@example.invalid`) {
  return { id, connection: { type: "ssh", destination } };
}

function executable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function remoteAssessment(f) {
  const result = f.run(["init", "--json"]);
  assert.equal(result.status, 6, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.command, "init");
  assert.equal(value.data.herdr.integration, "current");
  const file = path.join(f.root, "remote-result.json");
  fs.writeFileSync(file, result.stdout);
  return file;
}

test("target list is local-only by default and check local reuses read-only evaluation", (t) => {
  const f = fixture(t);
  const listed = f.run(["target", "list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const inventory = JSON.parse(listed.stdout);
  assert.deepEqual(inventory.data.targets, [{ id: "local", connection: { type: "local" }, state: "unknown" }]);
  assert.equal(fs.existsSync(f.stateDir), false);

  const checked = f.run(["target", "check", "local", "--json"]);
  assert.equal(checked.status, 4, checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.command, "target");
  assert.equal(result.data.summary.state, "attention");
  assert.equal(result.data.summary.classification, "repairable");
  assert.equal(result.data.summary.pi, "1.4.0");
  assert.equal(result.data.summary.herdr, "0.9.5");
  assert.equal(result.changes, "none");
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(f.commands().some((line) => /update|install|selftest/.test(line)), false);
});

test("SSH checks bind one target, accept read-only init exit 6, and export only public summaries", (t) => {
  const f = fixture(t);
  const remoteResult = remoteAssessment(f);
  const file = registry(f, [remote("linux-dev", "alice"), remote("offline"), remote("bad-json")]);
  executable(path.join(f.bin, "ssh"), `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *offline*) printf 'token=remote-secret\\n' >&2; exit 255 ;;
  *bad-json*) printf 'not json\\n'; exit 6 ;;
esac
cat "$MOCK_REMOTE_RESULT"
`);
  fs.writeFileSync(f.log, "");
  const env = { AGENTBREW_TARGETS_FILE: file, MOCK_REMOTE_RESULT: remoteResult };
  const checked = f.run(["target", "check", "linux-dev", "--json"], env);
  assert.equal(checked.status, 4, checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.data.summary.state, "attention");
  assert.equal(result.data.summary.pi, "1.4.0");
  assert.equal(result.data.summary.integration, "current");
  assert.equal(result.data.summary.checkedAt !== undefined, true);
  assert.equal(JSON.stringify(result.data).includes(f.agentDir), false);
  assert.equal(JSON.stringify(result.data).includes("manifest"), false);
  const ssh = f.commands().filter((line) => line.startsWith("ssh "));
  assert.equal(ssh.length, 1);
  assert.match(ssh[0], /-T -o BatchMode=yes -o ConnectTimeout=8 -- alice agentbrew init --json/);

  const offline = f.run(["target", "check", "offline", "--json"], env);
  assert.equal(offline.status, 1);
  assert.equal(JSON.parse(offline.stdout).data.summary.state, "offline");
  assert.equal(offline.stdout.includes("remote-secret"), false);
  assert.equal(offline.stderr.includes("remote-secret"), false);
  const malformed = f.run(["target", "check", "bad-json", "--json"], env);
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stdout).data.summary.errorKind, "protocol");
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.equal(f.commands().some((line) => /pi update|npm install|selftest/.test(line)), false);
});

test("unavailable remote Agentbrew is distinct from SSH transport failure", (t) => {
  const f = fixture(t);
  const file = registry(f, [remote("missing-agentbrew")]);
  executable(path.join(f.bin, "ssh"), "#!/bin/sh\nexit 127\n");
  const result = f.run(["target", "check", "missing-agentbrew", "--json"], { AGENTBREW_TARGETS_FILE: file });
  assert.equal(result.status, 1);
  const summary = JSON.parse(result.stdout).data.summary;
  assert.equal(summary.state, "unavailable");
  assert.equal(summary.errorKind, "agentbrew-unavailable");
});

test("damaged registries fail closed instead of silently becoming local-only", (t) => {
  const f = fixture(t);
  const invalid = [
    [remote("local")],
    [remote("duplicate"), remote("duplicate")],
    [remote("unsafe", "alice@example.invalid -oProxyCommand=bad")],
    [{ id: "unknown-field", connection: { type: "ssh", destination: "alice" }, extra: true }],
  ];
  for (const targets of invalid) {
    const file = registry(f, targets);
    const listed = f.run(["target", "list", "--json"], { AGENTBREW_TARGETS_FILE: file });
    assert.equal(listed.status, 1, listed.stderr || listed.stdout);
    assert.equal(f.commands().some((line) => line.startsWith("ssh ")), false);
  }
  const file = path.join(f.root, "broken.json");
  fs.writeFileSync(file, "not json\n");
  const broken = f.run(["target", "list", "--json"], { AGENTBREW_TARGETS_FILE: file });
  assert.equal(broken.status, 1);
  assert.match(JSON.parse(broken.stdout).error, /not valid JSON/);
});

test("a symlink registry is rejected", (t) => {
  const f = fixture(t);
  const actual = registry(f, [remote("linux-dev")]);
  const link = path.join(f.root, "linked-targets.json");
  fs.symlinkSync(actual, link);
  const result = f.run(["target", "list", "--json"], { AGENTBREW_TARGETS_FILE: link });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /non-symlink/);
});

test("an in-flight SSH check can be aborted without a target result", async (t) => {
  const f = fixture(t);
  executable(path.join(f.bin, "ssh"), `#!/bin/sh
node -e 'setTimeout(() => {}, 30000)'
`);
  const controller = new AbortController();
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  context.signal = controller.signal;
  const pending = checkTarget(context, { id: "slow", connection: { type: "ssh", destination: "slow" } });
  setTimeout(() => controller.abort(new Error("test cancellation")), 30);
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(fs.existsSync(f.stateDir), false);
});
