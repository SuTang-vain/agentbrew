import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { runCli } from "../dist/cli.js";
import { createContext } from "../dist/context.js";
import { createTerminalStyle, visibleWidth } from "../dist/terminal.js";
import { runTui } from "../dist/tui.js";
import { renderTuiFrame } from "../dist/tui-view.js";
import { AGENTBREW_VERSION } from "../dist/version.js";
import { fixture } from "./helpers.mjs";

function session(f, extraEnv = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode) => {
    input.rawModes.push(mode);
    input.isRaw = mode;
  };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const error = new PassThrough();
  let stdout = "";
  let stderr = "";
  output.on("data", (chunk) => { stdout += chunk.toString(); });
  error.on("data", (chunk) => { stderr += chunk.toString(); });
  return {
    input,
    output,
    streams: { input, output, error, interactive: true, env: f.env({ TERM: "xterm-256color", NO_COLOR: "1", ...extraEnv }) },
    text: () => stdout,
    errors: () => stderr,
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function currentFrame(s) {
  return stripVTControlCharacters(s.text().split("\x1b[H").at(-1));
}

async function waitForText(s, pattern) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (pattern.test(currentFrame(s))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`TUI did not render ${pattern}: ${currentFrame(s)}`);
}

function layerFile(f) {
  const file = path.join(f.root, "personal.json");
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-layer",
    layer: "personal",
    resources: {
      "npm:pi-subagents": {
        source: { type: "npm", spec: "^0.83.0" },
        update: "compatible",
      },
    },
  }, null, 2)}\n`);
  return file;
}

function targetRegistry(f) {
  const remoteResult = path.join(f.root, "remote-result.json");
  const assessment = f.run(["init", "--json"]);
  assert.equal(assessment.status, 6, assessment.stderr);
  fs.writeFileSync(remoteResult, assessment.stdout);
  const file = path.join(f.root, "targets.json");
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    kind: "agentbrew-targets",
    targets: [
      { id: "linux-dev", connection: { type: "ssh", destination: "alice" } },
      { id: "offline", connection: { type: "ssh", destination: "offline" } },
    ],
  }));
  return { file, remoteResult };
}

function assertNoMutatingCommands(f) {
  assert.equal(f.commands().some((command) => command.startsWith("pi update")), false);
  assert.equal(f.commands().some((command) => command.startsWith("npm install")), false);
  assert.equal(f.commands().some((command) => command.startsWith("herdr integration install")), false);
  assert.equal(f.commands().some((command) => command.includes("selftest")), false);
}

test("bare interactive commands enter a persistent read-only TUI and restore on q, Ctrl+C, and EOF", async (t) => {
  for (const [key, expected] of [["q", 0], ["\x03", 130], [null, 0]]) {
    const f = fixture(t);
    const s = session(f);
    const status = runCli([], s.streams);
    await settle();
    assert.ok(currentFrame(s).includes(`Agentbrew v${AGENTBREW_VERSION}`));
    assert.match(currentFrame(s), /READ ONLY/);
    assert.match(currentFrame(s), /Overview/);
    if (key === null) s.input.end();
    else s.input.write(key);
    assert.equal(await status, expected);
    assert.deepEqual(s.input.rawModes, [true, false]);
    assert.match(s.text(), /\x1b\[\?1049h/);
    assert.match(s.text(), /\x1b\[\?25h\x1b\[\?1049l/);
    assert.match(s.text(), /Agentbrew closed · no resources changed/);
    assert.equal(fs.existsSync(f.stateDir), false);
    assertNoMutatingCommands(f);
  }
});

test("Health, Differences, native Update preview, Sources, refresh, and Escape stay read-only", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const status = runCli([], s.streams);
  await settle();

  s.input.write("2");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Health/);
  assert.match(currentFrame(s), /health: unhealthy · 13 failed · 1 warning\(s\) · 3 passed/);
  assert.doesNotMatch(currentFrame(s), /^PASS /m);
  assertNoMutatingCommands(f);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  s.input.write("3");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Differences/);
  assert.match(currentFrame(s), /DIFF /);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  s.input.write("4");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Update preview/);
  assert.match(currentFrame(s), /PLAN Update Pi and configured extensions/);
  assert.match(currentFrame(s), /preview: local checks only/);
  assert.equal(fs.existsSync(f.stateDir), false);

  s.input.write("r");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Update preview/);
  assertNoMutatingCommands(f);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  s.input.write("5");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Sources/);
  assert.match(currentFrame(s), /sources: no per-target registration/);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  assert.equal(fs.existsSync(f.stateDir), false);
  assertNoMutatingCommands(f);
});

test("explicit layers are valid TUI inputs and remain distinguishable from registration", async (t) => {
  const f = fixture(t);
  const file = layerFile(f);
  const s = session(f);
  const status = runCli(["--layer", `personal=${file}`], s.streams);
  await settle();
  assert.match(currentFrame(s), /explicit · 1 layer\(s\)/);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("Help returns to the cached page, digits jump directly, and previews report progress", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  let healthCalls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const status = runTui(context, s.streams, {
    health: async () => {
      healthCalls += 1;
      return {
        schemaVersion: 1,
        command: "doctor",
        status: "success",
        target: { agentDir: f.agentDir },
        changes: "none",
        steps: [],
        differences: [],
        checks: [{ resource: "probe.health", status: "pass", message: `health-${healthCalls}` }],
      };
    },
    update: async (scoped) => {
      scoped.progress?.("resolving npm:probe (1/1)…");
      return pending;
    },
  });
  await settle();
  s.input.write("2");
  await settle();
  s.input.write("v");
  await settle();
  const health = currentFrame(s);
  assert.match(health, /Agentbrew · Health/);
  assert.match(health, /health-1/);
  assert.equal(health.includes("\ntarget:"), false);

  s.input.write("?");
  await settle();
  assert.match(currentFrame(s), /Navigation/);
  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(currentFrame(s), /Agentbrew · Health/);
  assert.match(currentFrame(s), /health-1/);
  assert.equal(healthCalls, 1);

  s.input.write("4");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Update preview/);
  assert.match(currentFrame(s), /resolving npm:probe \(1\/1\)/);
  release({ schemaVersion: 1, command: "update", status: "success", target: { agentDir: f.agentDir }, changes: "none", steps: [], differences: [], checks: [] });
  await settle();
  assert.match(currentFrame(s), /preview: up to date · no writes/);
  s.input.write("q");
  assert.equal(await status, 0);
});

test("Esc cancels an in-flight preview and restores the previous page", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  let healthCalls = 0;
  let updateCalls = 0;
  const status = runTui(context, s.streams, {
    health: async () => {
      healthCalls += 1;
      return {
        schemaVersion: 1,
        command: "doctor",
        status: "success",
        target: { agentDir: f.agentDir },
        changes: "none",
        steps: [],
        differences: [],
        checks: [{ resource: "probe.health", status: "pass", message: `health-${healthCalls}` }],
      };
    },
    update: async (scoped) => {
      updateCalls += 1;
      scoped.progress?.("resolving npm:probe…");
      await new Promise((_resolve, reject) => {
        scoped.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      throw new Error("unreachable");
    },
  });
  await settle();
  s.input.write("2");
  await settle();
  s.input.write("v");
  await settle();
  assert.match(currentFrame(s), /health-1/);

  s.input.write("4");
  await settle();
  assert.match(currentFrame(s), /resolving npm:probe/);
  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  const frame = currentFrame(s);
  assert.match(frame, /Agentbrew · Health/);
  assert.match(frame, /health-1/);
  assert.match(frame, /read-only request cancelled/);
  assert.equal(updateCalls, 1);
  assert.equal(healthCalls, 1);
  assert.equal(fs.existsSync(f.stateDir), false);
  s.input.write("q");
  assert.equal(await status, 0);
});

test("update preview states readiness, re-check, and native next steps", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  let call = 0;
  const resolvedPreview = {
    schemaVersion: 1,
    command: "update",
    status: "success",
    target: { agentDir: f.agentDir },
    changes: "none",
    steps: [{ id: "pi-host", label: "Update the Pi host to 1.5.0", status: "planned", changes: "none" }],
    differences: [],
    checks: [],
    data: {
      nativeMode: false,
      resolution: {
        host: { currentVersion: "1.4.0", targetVersion: "1.5.0", action: "update" },
        resources: [{ id: "npm:pi-subagents", currentVersion: "0.83.0", targetVersion: "0.83.1", action: "update", peerEvidence: [] }],
      },
    },
  };
  const nativePreview = {
    schemaVersion: 1,
    command: "update",
    status: "success",
    target: { agentDir: f.agentDir },
    changes: "none",
    steps: [{ id: "pi-update", label: "Update Pi and configured extensions", status: "planned", changes: "none" }],
    differences: [],
    checks: [],
    data: { nativeMode: true },
  };
  const status = runTui(context, s.streams, {
    update: async () => (call++ === 0 ? resolvedPreview : nativePreview),
  });
  await settle();
  s.input.write("4");
  await settle();
  const resolvedFrame = currentFrame(s);
  assert.match(resolvedFrame, /preview: ready · 2 update\(s\) · no writes/);
  assert.match(resolvedFrame, /r re-check/);
  assert.doesNotMatch(resolvedFrame, /u apply/);
  s.input.write("u");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Update preview/);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  s.input.write("4");
  await settle();
  const nativeFrame = currentFrame(s);
  assert.match(nativeFrame, /preview: local checks only · upstream versions unknown · no writes/);
  assert.match(nativeFrame, /agentbrew source set --layer personal=/);
  assert.match(nativeFrame, /Native update: agentbrew update/);
  assert.match(nativeFrame, /agentbrew adopt --output personal\.proposed\.json/);
  assert.doesNotMatch(nativeFrame, /agentbrew init/);
  s.input.write("q");
  assert.equal(await status, 0);
});

test("an ownership-blocked preview explains the required init step", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  const unmanaged = ["pi.host", "npm:a", "npm:b", "npm:c", "npm:d", "npm:e", "npm:f"];
  const blocked = {
    schemaVersion: 1,
    command: "update",
    status: "not-executed",
    target: { agentDir: f.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
    error: `native Pi update would exceed local ownership: ${unmanaged.join(", ")}; rerun init to select resources explicitly`,
    data: { nativeMode: true, unmanagedResources: unmanaged },
  };
  const status = runTui(context, s.streams, { update: async () => blocked });
  await settle();
  s.input.write("4");
  await settle();
  const frame = currentFrame(s);
  assert.match(frame, /preview: blocked · 7 resource\(s\) not managed · no writes/);
  assert.match(frame, /agentbrew init\s+\(choose Manage/);
  assert.match(frame, /unmanaged: pi\.host, npm:a, npm:b, npm:c \(\+3 more\)/);
  assert.doesNotMatch(frame, /would exceed local ownership/);
  s.input.write("q");
  assert.equal(await status, 0);
});

test("the Sources page explains how to persist a binding", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const status = runCli([], s.streams);
  await settle();
  s.input.write("5");
  await settle();
  const frame = currentFrame(s);
  assert.match(frame, /No per-target source binding is registered/);
  assert.match(frame, /agentbrew source set --layer personal=/);
  assert.match(frame, /agentbrew adopt --output personal\.proposed\.json/);
  s.input.write("q");
  assert.equal(await status, 0);
});

test("write mode changes the safety line, menu description, and help", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  const status = runTui(context, s.streams, {}, { write: true });
  await settle();
  assert.match(currentFrame(s), /Writes only after confirmation/);
  s.input.write("\x1b[B\x1b[B\x1b[B\x1b[B");
  await settle();
  assert.match(currentFrame(s), /apply only after confirmation/);
  s.input.write("?");
  await settle();
  assert.match(currentFrame(s), /any active operation settles/);
  assert.match(currentFrame(s), /Apply the preview \(only with --write/);
  s.input.write("q");
  assert.equal(await status, 0);
});

test("--write is limited to the interactive workspace", async (t) => {
  const f = fixture(t);
  const s = session(f);
  assert.equal(await runCli(["--write", "update"], s.streams), 2);
  assert.equal(await runCli(["--write", "--json"], s.streams), 2);
  assert.equal(f.run(["--write"]).status, 2);
});

test("--write confirms before applying and reports the result", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  let updateCalls = 0;
  let applyCalls = 0;
  let applyDryRun;
  const preview = {
    schemaVersion: 1,
    command: "update",
    status: "success",
    target: { agentDir: f.agentDir },
    changes: "none",
    steps: [
      { id: "pi-host", label: "Update the Pi host to 1.5.0", status: "planned", changes: "none" },
      { id: "npm-install", label: "Generate and install an exact lock plan", status: "planned", changes: "none" },
      { id: "herdr-integration", label: "Rebuild the herdr Pi integration", status: "planned", changes: "none" },
    ],
    differences: [],
    checks: [],
    data: {
      nativeMode: false,
      resolution: {
        host: { currentVersion: "1.4.0", targetVersion: "1.5.0", action: "update" },
        resources: [{ id: "npm:pi-subagents", currentVersion: "0.83.0", targetVersion: "0.83.1", action: "update", peerEvidence: [] }],
      },
    },
  };
  const applied = {
    schemaVersion: 1,
    command: "update",
    status: "success",
    target: { agentDir: f.agentDir },
    changes: "observed",
    steps: [{ id: "npm-install", label: "Install the complete exact-version npm lock plan", status: "success", changes: "observed" }],
    differences: [],
    checks: [],
  };
  const status = runTui(context, s.streams, {
    update: async () => {
      updateCalls += 1;
      return preview;
    },
    apply: async (scoped) => {
      applyCalls += 1;
      applyDryRun = scoped.dryRun;
      return applied;
    },
  }, { write: true });
  await settle();
  s.input.write("4");
  await settle();
  assert.match(currentFrame(s), /WRITE ENABLED/);
  assert.match(currentFrame(s), /u apply/);

  s.input.write("u");
  await settle();
  const confirmFrame = currentFrame(s);
  assert.match(confirmFrame, /Agentbrew · Apply update\?/);
  assert.match(confirmFrame, /Host\s+1\.4\.0 → 1\.5\.0/);
  assert.match(confirmFrame, /npm\s+pi-subagents 0\.83\.0 → 0\.83\.1/);
  assert.match(confirmFrame, /› Cancel/);
  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(currentFrame(s), /Agentbrew · Update preview/);
  assert.equal(applyCalls, 0);

  s.input.write("u");
  await settle();
  s.input.write("\x1b[A");
  await settle();
  assert.match(currentFrame(s), /› Update now/);
  s.input.write("\r");
  await settle();
  assert.equal(applyCalls, 1);
  assert.equal(applyDryRun, false);
  assert.match(currentFrame(s), /Agentbrew · Update result/);
  assert.match(currentFrame(s), /Restart Pi to load the updated host and extensions\./);

  s.input.write("r");
  await settle();
  assert.equal(updateCalls, 2);
  assert.match(currentFrame(s), /Agentbrew · Update preview/);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.match(s.text(), /Agentbrew closed · last update: success/);
  assert.doesNotMatch(s.text(), /Agentbrew closed · no resources changed/);
});

test("a repairs-only preview is not reported as up to date", (t) => {
  const f = fixture(t);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const style = createTerminalStyle(output, { NO_COLOR: "1" });
  const result = {
    schemaVersion: 1,
    command: "update",
    status: "success",
    target: { agentDir: f.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
    data: {
      nativeMode: false,
      npmRequired: true,
      resolution: { host: { currentVersion: "1.4.0", targetVersion: "1.4.0", action: "keep" }, resources: [] },
    },
  };
  const frame = stripVTControlCharacters(renderTuiFrame({
    target: f.agentDir,
    page: "update",
    menuIndex: 0,
    busy: false,
    exitRequested: false,
    scroll: 0,
    result,
  }, style, 16).lines.join("\n"));
  assert.match(frame, /preview: no version updates · repairs planned · no writes/);
  assert.doesNotMatch(frame, /preview: up to date/);
});

test("a successful preview is cached for the session and r refreshes it", async (t) => {
  const f = fixture(t);
  const file = layerFile(f);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir, layers: [`personal=${file}`] }, f.env());
  let calls = 0;
  const preview = {
    schemaVersion: 1,
    command: "update",
    status: "success",
    target: { agentDir: f.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
  };
  const status = runTui(context, s.streams, {
    update: async () => {
      calls += 1;
      return preview;
    },
  });
  await settle();
  s.input.write("4");
  await settle();
  assert.equal(calls, 1);
  assert.doesNotMatch(currentFrame(s), /cached \d+s ago/);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  s.input.write("4");
  await settle();
  assert.equal(calls, 1);
  assert.match(currentFrame(s), /cached \d+s ago/);

  s.input.write("r");
  await settle();
  assert.equal(calls, 2);
  assert.doesNotMatch(currentFrame(s), /cached \d+s ago/);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  const layer = JSON.parse(fs.readFileSync(file, "utf8"));
  layer.resources["npm:pi-subagents"].source.spec = "^0.84.0";
  fs.writeFileSync(file, JSON.stringify(layer, null, 2));
  s.input.write("4");
  await settle();
  assert.equal(calls, 3);
  s.input.write("q");
  assert.equal(await status, 0);
});

test("a damaged registered binding fails update preview closed without native fallback", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir, { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, "sources.json"), "not json\n");
  const s = session(f);
  const status = runCli([], s.streams);
  await settle();
  assert.match(currentFrame(s), /source error/);
  s.input.write("4");
  await settle();
  const frame = currentFrame(s);
  assert.match(frame, /sources: registered/);
  assert.match(frame, /preview: not-executed · no writes/);
  assert.doesNotMatch(frame, /PLAN Update Pi/);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.deepEqual(fs.readdirSync(f.stateDir), ["sources.json"]);
  assertNoMutatingCommands(f);
});

test("an asynchronous preview prevents reentry and settles before a requested exit", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const status = runTui(context, s.streams, {
    update: async () => {
      calls += 1;
      return pending;
    },
  });
  await settle();
  s.input.write("4");
  await settle();
  assert.equal(calls, 1);
  s.input.write("r\r\x1b[B\r");
  await settle();
  assert.equal(calls, 1);
  assert.match(currentFrame(s), /read-only · \d+s/);
  s.input.write("q");
  await settle();
  assert.match(currentFrame(s), /Finishing the read-only operation before exit/);
  assert.equal(s.input.isRaw, true);
  release({
    schemaVersion: 1,
    command: "update",
    status: "success",
    target: { agentDir: f.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: [],
  });
  assert.equal(await status, 0);
  assert.equal(calls, 1);
  assert.deepEqual(s.input.rawModes, [true, false]);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("non-TTY, JSON, help, and dumb-terminal fallback do not start the visual session", async (t) => {
  const f = fixture(t);
  const nonTty = f.run([]);
  assert.equal(nonTty.status, 0);
  assert.match(nonTty.stdout, /Usage: agentbrew/);
  assert.doesNotMatch(nonTty.stdout, /\x1b\[\?1049h/);

  const jsonSession = session(f);
  assert.equal(await runCli(["--json"], jsonSession.streams), 6);
  assert.equal(JSON.parse(jsonSession.text()).command, "init");
  assert.deepEqual(jsonSession.input.rawModes, []);

  const helpSession = session(f);
  assert.equal(await runCli(["--help"], helpSession.streams), 0);
  assert.match(helpSession.text(), /read-only workspace/);
  assert.deepEqual(helpSession.input.rawModes, []);

  const fallback = session(f, { TERM: "dumb" });
  const status = runCli([], fallback.streams);
  fallback.input.write("\n");
  assert.equal(await status, 0);
  assert.match(fallback.text(), /classification: repairable/);
  assert.doesNotMatch(fallback.text(), /\x1b\[\?1049h/);

  const tiny = session(f);
  tiny.output.rows = 4;
  const tinyStatus = runCli([], tiny.streams);
  tiny.input.write("\n");
  assert.equal(await tinyStatus, 0);
  assert.match(tiny.text(), /classification: repairable/);
  assert.doesNotMatch(tiny.text(), /\x1b\[\?1049h/);
});

test("TUI frames fit width and height, retain the selected item, and clamp scrolling", (t) => {
  const f = fixture(t);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 32;
  const style = createTerminalStyle(output, { NO_COLOR: "1" });
  const model = {
    target: path.join(f.agentDir, "配置", "a-very-long-target-path"),
    page: "overview",
    menuIndex: 7,
    busy: true,
    exitRequested: false,
    scroll: 0,
  };
  const frame = renderTuiFrame(model, style, 12);
  assert.ok(frame.lines.length <= 12);
  assert.match(stripVTControlCharacters(frame.lines.join("\n")), /Quit/);
  assert.match(stripVTControlCharacters(frame.lines.join("\n")), /\d+–8\/8 pages/);
  for (const line of frame.lines) assert.ok(visibleWidth(line) <= 32);
  model.page = "help";
  model.busy = false;
  model.scroll = 1000;
  const scrolled = renderTuiFrame(model, style, 8);
  assert.ok(scrolled.lines.length <= 8);
  assert.ok(scrolled.scroll > 0);
  assert.ok(scrolled.scroll < 1000);

  model.page = "health";
  model.scroll = 0;
  model.result = {
    schemaVersion: 1,
    command: "doctor",
    status: "unhealthy",
    target: { agentDir: "/tmp/target" },
    changes: "none",
    steps: [],
    differences: [],
    checks: Array.from({ length: 30 }, (_, index) => ({ resource: `check-${index}`, status: "pass", message: "x".repeat(60) })),
  };
  for (const height of [5, 6, 8, 12, 24]) {
    const rendered = renderTuiFrame(model, style, height);
    assert.ok(rendered.lines.length <= height, `height ${height} produced ${rendered.lines.length} lines`);
  }

  const narrow = createTerminalStyle(Object.assign(new PassThrough(), { isTTY: true, columns: 32, rows: 12 }), { NO_COLOR: "1" }, true);
  model.busy = true;
  model.busySince = Date.now() - 3500;
  assert.match(stripVTControlCharacters(renderTuiFrame(model, narrow, 12).lines.join("\n")), /read-only · \d+s/);
  model.page = "applied";
  const applying = stripVTControlCharacters(renderTuiFrame(model, narrow, 12).lines.join("\n"));
  assert.match(applying, /applying · \d+s/);
  assert.match(applying, /esc disabled/);
  model.page = "health";
  model.busy = false;
  model.busySince = undefined;
  model.page = "overview";
  const overview = stripVTControlCharacters(renderTuiFrame(model, narrow, 12).lines.join("\n"));
  assert.match(overview, /\? help/);
  assert.match(overview, /q quit/);
});

test("raw-mode startup failure restores the cursor, screen, and input", async (t) => {
  const f = fixture(t);
  const s = session(f);
  s.input.setRawMode = (mode) => {
    s.input.rawModes.push(mode);
    s.input.isRaw = mode;
    if (mode) throw new Error("simulated raw-mode failure");
  };
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  assert.equal(await runTui(context, s.streams), 1);
  assert.deepEqual(s.input.rawModes, [true, false]);
  assert.match(s.text(), /\x1b\[\?25h\x1b\[\?1049l/);
  assert.match(s.errors(), /simulated raw-mode failure/);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("detail toggles reuse the current health result without another operation", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  let healthCalls = 0;
  const status = runTui(context, s.streams, {
    health: async () => {
      healthCalls += 1;
      return {
        schemaVersion: 1,
        command: "doctor",
        status: "unhealthy",
        target: { agentDir: f.agentDir },
        changes: "none",
        steps: [],
        differences: [],
        checks: [
          { resource: "probe.pass", status: "pass", message: "passing detail" },
          { resource: "probe.fail", status: "fail", message: "actionable failure" },
          { resource: "probe.warn", status: "warn", message: "actionable warning" },
        ],
      };
    },
  });
  await settle();
  s.input.write("2");
  await settle();
  const summary = currentFrame(s);
  assert.match(summary, /health: unhealthy · 1 failed · 1 warning\(s\) · 1 passed/);
  assert.match(summary, /actionable failure/);
  assert.match(summary, /actionable warning/);
  assert.doesNotMatch(summary, /passing detail/);

  s.input.write("v");
  await settle();
  assert.match(currentFrame(s), /PASS probe\.pass: passing detail/);
  assert.match(currentFrame(s), /v summary/);
  s.input.write("v");
  await settle();
  assert.doesNotMatch(currentFrame(s), /passing detail/);
  assert.equal(healthCalls, 1);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("long results retain their final line and support viewport navigation", async (t) => {
  const f = fixture(t);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 60;
  const style = createTerminalStyle(output, { NO_COLOR: "1" });
  const result = {
    schemaVersion: 1,
    command: "doctor",
    status: "success",
    target: { agentDir: f.agentDir },
    changes: "none",
    steps: [],
    differences: [],
    checks: Array.from({ length: 30 }, (_, index) => ({ resource: `check-${index}`, status: "pass", message: "detail" })),
  };
  const last = renderTuiFrame({
    target: f.agentDir,
    page: "health",
    menuIndex: 1,
    busy: false,
    exitRequested: false,
    scroll: 1000,
    showDetails: true,
    result,
  }, style, 8);
  assert.match(last.lines.join("\n"), /PASS check-29: detail/);
  assert.ok(last.lines.length <= 8);
  assert.ok(last.pageSize > 0);

  const s = session(f);
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, f.env());
  const status = runTui(context, s.streams, {
    health: async () => ({
      ...result,
      status: "unhealthy",
      checks: Array.from({ length: 40 }, (_, index) => ({ resource: `check-${index}`, status: "warn", message: `health-row-${index}` })),
    }),
  });
  await settle();
  s.input.write("\x1b[F");
  await settle();
  assert.match(currentFrame(s), /› Quit/);
  s.input.write("\x1b[H");
  await settle();
  assert.match(currentFrame(s), /› Overview/);
  s.input.write("2");
  await settle();
  assert.match(currentFrame(s), /health-row-0/);
  s.input.write("\x1b[F");
  await settle();
  assert.match(currentFrame(s), /health-row-39/);
  s.input.write("\x1b[H");
  await settle();
  assert.match(currentFrame(s), /health-row-0/);
  s.input.write("\x1b[6");
  await settle();
  s.input.write("~");
  await settle();
  assert.doesNotMatch(currentFrame(s), /health-row-0/);
  s.input.write("\x1b[5~");
  await settle();
  assert.match(currentFrame(s), /health-row-0/);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.deepEqual(s.input.rawModes, [true, false]);
});

test("long confirmations keep both actions visible and expose the final safety detail", (t) => {
  const f = fixture(t);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 60;
  const style = createTerminalStyle(output, { NO_COLOR: "1" });
  const model = {
    target: f.agentDir,
    page: "confirm",
    menuIndex: 3,
    busy: false,
    exitRequested: false,
    scroll: 0,
    writeEnabled: true,
    confirmIndex: 1,
    confirm: {
      host: { from: "1.4.0", to: "1.5.0" },
      herdr: true,
      packages: Array.from({ length: 20 }, (_, index) => ({ id: `npm:package-${index}`, from: "1.0.0", to: "1.1.0" })),
    },
  };
  const top = renderTuiFrame(model, style, 15);
  assert.match(top.lines.join("\n"), /cannot be rolled back\s+automatically/);
  assert.match(top.lines.join("\n"), / Update now/);
  assert.match(top.lines.join("\n"), /› Cancel/);
  const bottom = renderTuiFrame({ ...model, scroll: 1000 }, style, 15);
  const text = bottom.lines.join("\n");
  assert.match(text, /selftest\s+not run \(opt-in\)/);
  assert.match(text, / Update now/);
  assert.match(text, /› Cancel/);
  assert.ok(bottom.lines.length <= 15);
});

test("Git sources distinguish local re-read from an explicit remote refresh", (t) => {
  const f = fixture(t);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 60;
  const style = createTerminalStyle(output, { NO_COLOR: "1" });
  const frame = renderTuiFrame({
    target: f.agentDir,
    page: "sources",
    menuIndex: 4,
    busy: false,
    exitRequested: false,
    scroll: 0,
    result: {
      schemaVersion: 1,
      command: "source",
      status: "success",
      target: { agentDir: f.agentDir },
      changes: "none",
      steps: [],
      differences: [],
      checks: [],
      data: {
        registered: true,
        state: "current",
        layers: [{
          layer: "team",
          file: "/private/cache/team.json",
          git: { url: "https://example.invalid/config.git", path: "team.json", ref: "HEAD", commit: "a".repeat(40) },
        }],
      },
    },
  }, style, 23);
  const text = frame.lines.join("\n");
  assert.match(text, /sources: registered · current · 1 layer\(s\) · 1 Git/);
  assert.match(text, /r only re-reads local\s+state/);
  assert.match(text, /agentbrew source refresh/);
  assert.match(text, /r re-read/);
  assert.doesNotMatch(text, /v details/);
});

test("Targets start without SSH, check only the selection, and retain session evidence", async (t) => {
  const f = fixture(t);
  const { file, remoteResult } = targetRegistry(f);
  const ssh = path.join(f.bin, "ssh");
  fs.writeFileSync(ssh, `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$MOCK_LOG"
case "$*" in *offline*) exit 255 ;; esac
cat "$MOCK_REMOTE_RESULT"
`);
  fs.chmodSync(ssh, 0o755);
  fs.writeFileSync(f.log, "");
  const s = session(f, { AGENTBREW_TARGETS_FILE: file, MOCK_REMOTE_RESULT: remoteResult });
  const status = runCli(["--write"], s.streams);
  await settle();
  assert.match(currentFrame(s), /3 configured · 1 attention · 2 unknown/);
  assert.equal(f.commands().some((line) => line.startsWith("ssh ")), false);

  s.input.write("t");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Targets/);
  assert.match(currentFrame(s), /linux-dev\s+ssh · unknown/);
  assert.match(currentFrame(s), /no remote updates/);
  s.input.write("\x1b[B");
  await settle();
  s.input.write("r");
  await waitForText(s, /linux-dev\s+ssh · attention/);
  assert.match(currentFrame(s), /linux-dev\s+ssh · attention/);
  assert.match(currentFrame(s), /offline\s+ssh · unknown/);
  assert.equal(f.commands().filter((line) => line.startsWith("ssh ")).length, 1);

  s.input.write("v");
  await settle();
  assert.match(currentFrame(s), /connection: alice/);
  s.input.write("2");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Health/);
  s.input.write("t");
  await settle();
  assert.match(currentFrame(s), /linux-dev\s+ssh · attention/);
  assert.equal(f.commands().filter((line) => line.startsWith("ssh ")).length, 1);

  s.input.write("2");
  await settle();
  const changed = JSON.parse(fs.readFileSync(file, "utf8"));
  changed.targets[0].connection.destination = "other";
  fs.writeFileSync(file, JSON.stringify(changed));
  s.input.write("t");
  await settle();
  assert.match(currentFrame(s), /linux-dev\s+ssh · unknown/);
  s.input.write("r");
  await waitForText(s, /linux-dev\s+ssh · attention/);
  const sshCommands = f.commands().filter((line) => line.startsWith("ssh "));
  assert.equal(sshCommands.length, 2);
  assert.match(sshCommands[1], /-- other agentbrew init --json/);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.deepEqual(s.input.rawModes, [true, false]);
  assert.equal(fs.existsSync(f.stateDir), false);
  assertNoMutatingCommands(f);
});

test("cancelling a selected target check restores its previous state", async (t) => {
  const f = fixture(t);
  const { file } = targetRegistry(f);
  const s = session(f, { AGENTBREW_TARGETS_FILE: file });
  const context = createContext({ agentDir: f.agentDir, stateDir: f.stateDir }, s.streams.env);
  let calls = 0;
  const status = runTui(context, s.streams, {
    checkTarget: async (scoped) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        scoped.signal?.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  }, { write: true });
  await settle();
  s.input.write("t");
  await settle();
  s.input.write("\x1b[B");
  await settle();
  s.input.write("r");
  await settle();
  assert.match(currentFrame(s), /Checking linux-dev only/);
  assert.match(currentFrame(s), /linux-dev\s+ssh · checking/);
  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  assert.match(currentFrame(s), /linux-dev\s+ssh · unknown/);
  assert.match(currentFrame(s), /read-only request cancelled/);
  assert.equal(calls, 1);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.deepEqual(s.input.rawModes, [true, false]);
  assertNoMutatingCommands(f);
});

test("reopening Targets preserves the local evidence timestamp", async (t) => {
  const f = fixture(t);
  const s = session(f);
  const status = runCli([], s.streams);
  await settle();
  s.input.write("t");
  await settle();
  s.input.write("v");
  await settle();
  const first = currentFrame(s).match(/checkedAt: (\S+)/)?.[1];
  assert.ok(first);

  s.input.write("2");
  await settle();
  s.input.write("t");
  await settle();
  s.input.write("v");
  await settle();
  assert.equal(currentFrame(s).match(/checkedAt: (\S+)/)?.[1], first);
  s.input.write("q");
  assert.equal(await status, 0);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("Overview keeps target evidence visible in a short terminal", (t) => {
  const f = fixture(t);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 60;
  const style = createTerminalStyle(output, { NO_COLOR: "1" });
  const frame = renderTuiFrame({
    target: f.agentDir,
    page: "overview",
    menuIndex: 0,
    busy: false,
    exitRequested: false,
    scroll: 0,
    evaluation: {
      assessment: { classification: "healthy", host: { version: "1.4.0", source: "managed" } },
      checks: [],
      differences: [],
      herdr: { available: true, version: "0.9.5", integration: "current" },
    },
    sources: { status: "success", data: { registered: false } },
    targets: {
      targets: [
        { id: "local", connection: { type: "local" }, state: "healthy" },
        { id: "linux-dev", connection: { type: "ssh", destination: "alice" }, state: "unknown" },
        { id: "offline", connection: { type: "ssh", destination: "offline" }, state: "unknown" },
      ],
    },
  }, style, 15);
  assert.match(frame.lines.join("\n"), /Targets\s+3 configured · 1 healthy · 2 unknown/);
});
