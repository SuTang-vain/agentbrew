import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCli } from "../dist/cli.js";
import { fixture, readJson } from "./helpers.mjs";

function interactive(answers, f, output) {
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const prompts = ["resources (comma-separated, or q)> ", "new proposal file> ", `write 1 resource(s) to ${output}? [y/N]> `];
  let index = 0;
  let text = "";
  let error = "";
  stdout.on("data", (chunk) => {
    text += chunk.toString();
    if (index < answers.length && text.endsWith(prompts[index])) {
      input.write(`${answers[index++]}\n`);
      if (index === answers.length) input.end();
    }
  });
  stderr.on("data", (chunk) => { error += chunk.toString(); });
  return { streams: { input, output: stdout, error: stderr, interactive: true, env: f.env({ TERM: "dumb" }) }, text: () => ({ stdout: text, stderr: error }) };
}

test("adopt writes only a new manual personal-layer proposal", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const output = path.join(f.root, "proposal.json");
  const missing = f.run(["adopt", "--json"]);
  assert.equal(missing.status, 6);
  const result = f.run(["adopt", "--resource", "npm:pi-subagents", "--output", output, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.changes, "none");
  assert.equal(payload.data.proposalOnly, true);
  const proposal = readJson(output);
  assert.equal(proposal.layer, "personal");
  assert.deepEqual(proposal.resources["npm:pi-subagents"], { source: { type: "npm", spec: "^0.83.0" }, update: "manual" });
  assert.equal(Object.keys(proposal.resources).some((id) => id.includes("@earendil-works")), false);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  assert.equal(fs.existsSync(f.stateDir), false);
  const repeated = f.run(["adopt", "--resource", "npm:pi-subagents", "--output", output, "--json"]);
  assert.equal(repeated.status, 6);
  assert.equal(fs.readFileSync(output, "utf8"), JSON.stringify(proposal, null, 2) + "\n");
  assert.equal(f.commands().some((command) => command.includes("install") || command.includes("update") || command.includes("selftest")), false);
});

test("adopt rejects internal packages and non-registry sources without a proposal", (t) => {
  const f = fixture(t);
  const internal = f.run(["adopt", "--resource", "npm:@earendil-works/pi-ai", "--output", path.join(f.root, "internal.json"), "--json"]);
  assert.equal(internal.status, 6);
  const manifest = readJson(path.join(f.npmDir, "package.json"));
  manifest.dependencies["local-package"] = "file:../private";
  fs.writeFileSync(path.join(f.npmDir, "package.json"), JSON.stringify(manifest));
  const output = path.join(f.root, "local.json");
  const local = f.run(["adopt", "--resource", "npm:local-package", "--output", output, "--json"]);
  assert.equal(local.status, 6);
  assert.match(JSON.parse(local.stdout).error, /cannot infer/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("interactive adopt supports numbered selection and only creates the reviewed file", async (t) => {
  const f = fixture(t);
  const output = path.join(f.root, "interactive.json");
  const session = interactive(["1", output, "y"], f, output);
  const status = await runCli(["adopt"], session.streams);
  assert.equal(status, 0, session.text().stderr);
  assert.deepEqual(Object.keys(readJson(output).resources), ["npm:pi-subagents"]);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("interactive adopt cancellation creates neither a proposal nor local state", async (t) => {
  const f = fixture(t);
  const output = path.join(f.root, "cancelled.json");
  const session = interactive(["q"], f, output);
  const status = await runCli(["adopt"], session.streams);
  assert.equal(status, 5);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("visual adopt supports arrows and restores raw terminal state", async (t) => {
  const f = fixture(t);
  const output = path.join(f.root, "visual.json");
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode) => {
    input.rawModes.push(mode);
    input.isRaw = mode;
  };
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 80;
  const stderr = new PassThrough();
  let text = "";
  let stage = 0;
  stdout.on("data", (chunk) => {
    text += chunk.toString();
    if (stage === 0 && text.includes("Select resources to export")) {
      stage = 1;
      input.write(" \r");
    } else if (stage === 1 && text.endsWith("new proposal file> ")) {
      stage = 2;
      input.write(`${output}\n`);
    } else if (stage === 2 && text.includes("Write 1 resource(s) to")) {
      stage = 3;
      input.write("\x1b[A\r");
      input.end();
    }
  });
  const status = await runCli(["adopt"], { input, output: stdout, error: stderr, interactive: true, env: f.env({ TERM: "xterm-256color", NO_COLOR: "1" }) });
  assert.equal(status, 0, text);
  assert.equal(stage, 3);
  assert.equal(readJson(output).resources["npm:pi-subagents"].update, "manual");
  assert.deepEqual(input.rawModes, [true, false, true, false]);
  assert.equal(fs.existsSync(f.stateDir), false);
});
