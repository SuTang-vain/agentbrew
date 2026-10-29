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
    assert.match(currentFrame(s), /Agentbrew/);
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

  s.input.write("\x1b[B\r");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Health/);
  assert.match(currentFrame(s), /result: unhealthy; changes: none/);
  assertNoMutatingCommands(f);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  s.input.write("\x1b[B\r");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Differences/);
  assert.match(currentFrame(s), /DIFF /);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  s.input.write("\x1b[B\r");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Update preview/);
  assert.match(currentFrame(s), /PLAN Update Pi and configured extensions/);
  assert.match(currentFrame(s), /result: success; changes: none/);
  assert.equal(fs.existsSync(f.stateDir), false);

  s.input.write("r");
  await settle();
  assert.match(currentFrame(s), /Agentbrew · Update preview/);
  assertNoMutatingCommands(f);

  s.input.write("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  s.input.write("\x1b[B\r");
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
  s.input.write("\x1b[B\r");
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
  assert.match(currentFrame(s), /result: success; changes: none/);
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
  s.input.write("\x1b[B\r");
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
  s.input.write("\x1b[B\x1b[B\x1b[B\r");
  await settle();
  const frame = currentFrame(s);
  assert.match(frame, /sources: registered/);
  assert.match(frame, /result: not-executed; changes: none/);
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
  s.input.write("\x1b[B\x1b[B\x1b[B\r");
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
    menuIndex: 6,
    busy: true,
    exitRequested: false,
    scroll: 0,
  };
  const frame = renderTuiFrame(model, style, 12);
  assert.ok(frame.lines.length <= 12);
  assert.match(stripVTControlCharacters(frame.lines.join("\n")), /Quit/);
  assert.match(stripVTControlCharacters(frame.lines.join("\n")), /\d+–7\/7 pages/);
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
