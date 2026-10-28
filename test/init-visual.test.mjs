import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCli } from "../dist/cli.js";
import { fixture, readJson } from "./helpers.mjs";

function visualSession(f, respond) {
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
  output.columns = 64;
  const error = new PassThrough();
  error.isTTY = true;
  error.columns = 64;
  let stdout = "";
  let stderr = "";
  output.on("data", (chunk) => {
    stdout += chunk.toString();
    respond(input, stdout);
  });
  error.on("data", (chunk) => { stderr += chunk.toString(); });
  const env = { ...f.env(), TERM: "xterm-256color" };
  delete env.NO_COLOR;
  return { streams: { input, output, error, interactive: true, env }, text: () => ({ stdout, stderr }), input };
}

test("visual init defaults to Observe with a styled summary", async (t) => {
  const f = fixture(t);
  const session = visualSession(f, (input, text) => {
    if (!session.sent && text.includes("Choose an action")) {
      session.sent = true;
      input.write("\r");
      input.end();
    }
  });
  session.sent = false;
  const status = await runCli(["init"], session.streams);
  assert.equal(status, 0, session.text().stderr);
  assert.match(session.text().stdout, /Guided setup/);
  assert.match(session.text().stdout, /Repairable · existing configuration needs attention/);
  assert.match(session.text().stdout, /\x1b\[/);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.deepEqual(session.input.rawModes, [true, false]);
});

test("arrow-key Repair preserves declarations and restores the terminal", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  let stage = 0;
  const session = visualSession(f, (input, text) => {
    if (stage === 0 && text.includes("Choose an action")) {
      stage = 1;
      input.write("\x1b[B\x1b[B\r");
    } else if (stage === 1 && text.includes("Select resources")) {
      stage = 2;
      input.write("\x1b[B \x1b[B \r");
    } else if (stage === 2 && text.includes("Apply this plan?")) {
      stage = 3;
      input.write("\x1b[A\r");
      input.end();
    }
  });
  const status = await runCli(["init"], session.streams);
  assert.equal(status, 0, session.text().stderr);
  assert.equal(stage, 3);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  const ownership = readJson(path.join(f.stateDir, "ownership.json"));
  assert.equal(ownership.resources["pi.host-links"], "generate");
  assert.equal(ownership.resources["herdr.pi-integration"], "generate");
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.deepEqual(session.input.rawModes, [true, false, true, false, true, false]);
  assert.match(session.text().stdout, /Agentbrew · init/);
});

test("the visual confirmation defaults to Cancel with zero writes", async (t) => {
  const f = fixture(t);
  let stage = 0;
  const session = visualSession(f, (input, text) => {
    if (stage === 0 && text.includes("Choose an action")) {
      stage = 1;
      input.write("\x1b[B\x1b[B\r");
    } else if (stage === 1 && text.includes("Select resources")) {
      stage = 2;
      input.write("\x1b[B \r");
    } else if (stage === 2 && text.includes("Apply this plan?")) {
      stage = 3;
      input.write("\r");
      input.end();
    }
  });
  const status = await runCli(["init"], session.streams);
  assert.equal(status, 5);
  assert.equal(stage, 3);
  assert.equal(fs.existsSync(path.join(f.npmDir, "host-link")), false);
  assert.equal(fs.existsSync(f.stateDir), false);
  assert.deepEqual(session.input.rawModes, [true, false, true, false, true, false]);
});

test("JSON output never contains terminal control sequences", (t) => {
  const f = fixture(t);
  const result = f.run(["init", "--json"]);
  assert.equal(result.status, 6);
  assert.equal(result.stdout.includes("\x1b"), false);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
});
