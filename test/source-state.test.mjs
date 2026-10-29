import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext } from "../dist/context.js";
import {
  readSourceRegistration,
  sourceRegistrationFingerprint,
  writeSourceRegistration,
} from "../dist/source-state.js";
import { fixture } from "./helpers.mjs";

function context(f, layers = []) {
  return createContext({ agentDir: f.agentDir, stateDir: f.stateDir, layers }, f.env());
}

function registration(f) {
  return {
    schemaVersion: 1,
    kind: "agentbrew-source-registration",
    target: { agentDir: f.agentDir },
    layers: [{ layer: "personal", file: path.join(f.root, "personal.json"), sha256: "a".repeat(64) }],
    inputHash: "b".repeat(64),
  };
}

test("source registration round-trips privately and fingerprints only non-explicit inputs", (t) => {
  const f = fixture(t);
  const registered = context(f);
  assert.equal(readSourceRegistration(registered), null);
  assert.equal(sourceRegistrationFingerprint(registered), "none");
  const expected = registration(f);
  writeSourceRegistration(registered, expected);
  assert.deepEqual(readSourceRegistration(registered), expected);
  assert.equal(fs.statSync(path.join(f.stateDir, "sources.json")).mode & 0o777, 0o600);
  assert.notEqual(sourceRegistrationFingerprint(registered), "none");
  const explicit = context(f, [`personal=${path.join(f.root, "personal.json")}`]);
  assert.equal(sourceRegistrationFingerprint(explicit), "explicit");
});

test("all four layer kinds remain ordered and target-bound", (t) => {
  const f = fixture(t);
  const ctx = context(f);
  const expected = registration(f);
  expected.layers = ["public", "team", "personal", "machine"].map((layer, index) => ({
    layer,
    file: path.join(f.root, `${layer}.json`),
    sha256: String(index).repeat(64),
  }));
  writeSourceRegistration(ctx, expected);
  assert.deepEqual(readSourceRegistration(ctx), expected);
});

test("invalid registration schemas and target mismatches fail closed", (t) => {
  const cases = [
    ["unknown field", (value) => { value.extra = true; }],
    ["target", (value) => { value.target.agentDir = "/tmp/other-target"; }],
    ["order", (value) => { value.layers.push({ layer: "public", file: "/tmp/public.json", sha256: "c".repeat(64) }); }],
    ["relative path", (value) => { value.layers[0].file = "personal.json"; }],
    ["hash", (value) => { value.inputHash = "not-a-hash"; }],
  ];
  for (const [name, mutate] of cases) {
    const f = fixture(t);
    const ctx = context(f);
    const value = registration(f);
    mutate(value);
    fs.mkdirSync(f.stateDir, { recursive: true });
    fs.writeFileSync(path.join(f.stateDir, "sources.json"), JSON.stringify(value));
    assert.throws(() => readSourceRegistration(ctx), undefined, name);
  }
});

test("oversized, malformed, and symlink source state is never loaded", (t) => {
  const malformed = fixture(t);
  fs.mkdirSync(malformed.stateDir, { recursive: true });
  fs.writeFileSync(path.join(malformed.stateDir, "sources.json"), "{");
  assert.throws(() => readSourceRegistration(context(malformed)), /sources\.json is not valid JSON/);
  fs.writeFileSync(path.join(malformed.stateDir, "sources.json"), "x".repeat(65 * 1024));
  assert.throws(() => readSourceRegistration(context(malformed)), /64 KiB/);

  const linked = fixture(t);
  const layer = path.join(linked.root, "personal.json");
  fs.writeFileSync(layer, "{}\n");
  fs.mkdirSync(linked.stateDir, { recursive: true });
  fs.symlinkSync(layer, path.join(linked.stateDir, "sources.json"));
  assert.throws(() => readSourceRegistration(context(linked)), /non-symlink/);
  assert.equal(sourceRegistrationFingerprint(context(linked)), "invalid-source-file-type");
  assert.equal(sourceRegistrationFingerprint(context(linked, [`personal=${layer}`])), "explicit");
});
