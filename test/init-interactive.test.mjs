import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCli } from "../dist/cli.js";
import { fixture, readJson } from "./helpers.mjs";

function io(inputText, f) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const answers = inputText.slice(0, -1).split("\n");
  const prompts = ["action> ", "resources> ", "apply this exact plan? [y/N]> "];
  let stdout = "";
  let stderr = "";
  let index = 0;
  output.on("data", (chunk) => {
    stdout += chunk.toString();
    if (index < answers.length && prompts[index] && stdout.endsWith(prompts[index])) {
      input.write(`${answers[index++]}\n`);
      if (index === answers.length) input.end();
    }
  });
  error.on("data", (chunk) => { stderr += chunk.toString(); });
  return { streams: { input, output, error, interactive: true, env: f.env() }, text: () => ({ stdout, stderr }) };
}

test("interactive init defaults to Observe with an aggregate summary", async (t) => {
  const f = fixture(t);
  const session = io("\n", f);
  const status = await runCli(["init"], session.streams);
  assert.equal(status, 0, session.text().stderr);
  assert.match(session.text().stdout, /classification: repairable/);
  assert.match(session.text().stdout, /result: success; changes: none/);
  assert.equal(session.text().stdout.includes("DIFF @earendil-works"), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("interactive cancellation is distinct and writes nothing", async (t) => {
  const f = fixture(t);
  const session = io("q\n", f);
  const status = await runCli(["init"], session.streams);
  assert.equal(status, 5);
  assert.match(session.text().stderr, /result: cancelled; changes: none/);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("interactive Repair uses numbered choices and preserves personal declarations", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8");
  const session = io("3\n2,3\ny\n", f);
  const status = await runCli(["init"], session.streams);
  assert.equal(status, 0, session.text().stderr);
  assert.match(session.text().stdout, /selected resources: pi.host-links, herdr.pi-integration/);
  assert.match(session.text().stdout, /remaining differences: 6 \(unselected/);
  assert.equal(session.text().stdout.includes("DIFF @earendil-works"), false);
  assert.equal(fs.readFileSync(path.join(f.npmDir, "package.json"), "utf8"), before);
  assert.equal(f.commands().includes("pi update --all"), false);
  assert.equal(f.commands().some((command) => command.startsWith("npm install")), false);
  const ownership = readJson(path.join(f.stateDir, "ownership.json"));
  assert.equal(ownership.resources["pi.host-links"], "generate");
  assert.equal(ownership.resources["herdr.pi-integration"], "generate");
});

test("declining the displayed plan leaves the target and state untouched", async (t) => {
  const f = fixture(t);
  const session = io("3\n2\nn\n", f);
  const status = await runCli(["init"], session.streams);
  assert.equal(status, 5);
  assert.equal(fs.existsSync(path.join(f.npmDir, "host-link")), false);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test("interactive Fresh selects only required base resources by default", async (t) => {
  const f = fixture(t);
  fs.rmSync(f.npmDir, { recursive: true, force: true });
  const session = io("2\n\ny\n", f);
  const status = await runCli(["init"], session.streams);
  assert.equal(status, 0, session.text().stderr);
  assert.match(session.text().stdout, /selected resources: pi.base/);
  const manifest = readJson(path.join(f.npmDir, "package.json"));
  assert.equal("pi-subagents" in manifest.dependencies, false);
  assert.equal(f.commands().includes("herdr integration install pi"), false);
  assert.equal(f.commands().includes("npm install --ignore-scripts --legacy-peer-deps"), true);
});
