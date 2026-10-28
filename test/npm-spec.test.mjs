import assert from "node:assert/strict";
import test from "node:test";
import { satisfiesNpmConstraint, validNpmConstraint } from "../dist/npm-spec.js";

test("the supported npm constraint subset rejects ambiguous and invalid versions", () => {
  assert.equal(validNpmConstraint("1.2.3"), true);
  assert.equal(validNpmConstraint("^0.83.0"), true);
  assert.equal(validNpmConstraint("~1.2.3-beta.1"), true);
  assert.equal(validNpmConstraint("^01.2.3"), false);
  assert.equal(validNpmConstraint("1.2.3-01"), false);
  assert.equal(validNpmConstraint("latest"), false);
  assert.equal(validNpmConstraint("^1.2.3", true), false);
});

test("installed versions are checked against exact, caret, and tilde constraints", () => {
  assert.equal(satisfiesNpmConstraint("0.83.0", "^0.83.0"), true);
  assert.equal(satisfiesNpmConstraint("0.83.9", "^0.83.0"), true);
  assert.equal(satisfiesNpmConstraint("0.84.0", "^0.83.0"), false);
  assert.equal(satisfiesNpmConstraint("0.2.9", "^0.2.3"), true);
  assert.equal(satisfiesNpmConstraint("0.3.0", "^0.2.3"), false);
  assert.equal(satisfiesNpmConstraint("0.0.4", "^0.0.3"), false);
  assert.equal(satisfiesNpmConstraint("1.2.9", "~1.2.3"), true);
  assert.equal(satisfiesNpmConstraint("1.3.0", "~1.2.3"), false);
  assert.equal(satisfiesNpmConstraint("1.3.0-beta.1", "^1.2.3"), false);
  assert.equal(satisfiesNpmConstraint("1.2.3-beta.2", "^1.2.3-beta.1"), true);
  assert.equal(satisfiesNpmConstraint("1.2.4-beta.1", "^1.2.3-beta.1"), false);
});
