import assert from "node:assert/strict";
import test from "node:test";
import { createMetadataClient } from "../dist/metadata.js";

test("metadata client constructs safe registry URLs and bounded JSON requests", async () => {
  const calls = [];
  const client = createMetadataClient({
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await client.getRelease(), { ok: true });
  assert.deepEqual(await client.getPackument("@earendil-works/pi-ai"), { ok: true });
  assert.deepEqual(await client.getManifest("pi-subagents", "0.83.1"), { ok: true });
  assert.equal(calls[0].url, "https://pi.dev/api/latest-version");
  assert.equal(calls[1].url, "https://registry.npmjs.org/%40earendil-works%2Fpi-ai");
  assert.equal(calls[2].url, "https://registry.npmjs.org/pi-subagents/0.83.1");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers["user-agent"], "agentbrew/0.1.0");
});

test("metadata endpoints reject insecure transport and embedded credentials", async () => {
  assert.throws(() => createMetadataClient({ registryUrl: "http://example.com" }), /HTTPS/);
  assert.throws(() => createMetadataClient({ releaseUrl: "https://alice:secret@example.com/version" }), /credentials/);
  const client = createMetadataClient({ registryUrl: "http://127.0.0.1:12345", fetchImpl: async () => Response.json({}) });
  assert.deepEqual(await client.getPackument("pi-subagents"), {});
});

test("metadata failures do not include response secrets", async () => {
  const client = createMetadataClient({
    fetchImpl: async () => new Response("token=secret-test-value", { status: 500 }),
  });
  await assert.rejects(client.getRelease(), (error) => {
    assert.match(error.message, /HTTP 500/);
    assert.equal(error.message.includes("secret-test-value"), false);
    return true;
  });
  const invalid = createMetadataClient({ fetchImpl: async () => new Response("not json") });
  await assert.rejects(invalid.getRelease(), /not valid JSON/);
});

test("metadata enforces byte limits and timeouts", async () => {
  const large = createMetadataClient({ maxBytes: 8, fetchImpl: async () => new Response("123456789") });
  await assert.rejects(large.getRelease(), /byte limit/);
  const slow = createMetadataClient({
    timeoutMs: 5,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  await assert.rejects(slow.getRelease(), /TimeoutError|timeout/i);
  const stalledBody = createMetadataClient({
    timeoutMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
  });
  await assert.rejects(stalledBody.getRelease(), /TimeoutError|timeout/i);
});

test("a caller abort cancels in-flight requests without waiting for the timeout", async () => {
  const controller = new AbortController();
  const client = createMetadataClient({
    signal: controller.signal,
    timeoutMs: 5_000,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  const pending = client.getRelease();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(pending, /cancelled/i);

  const early = new AbortController();
  early.abort();
  let called = false;
  const skipped = createMetadataClient({
    signal: early.signal,
    fetchImpl: async () => { called = true; return Response.json({}); },
  });
  await assert.rejects(skipped.getRelease(), /cancelled/i);
  assert.equal(called, false);
});

test("package and exact-version inputs are validated before network access", async () => {
  let called = false;
  const client = createMetadataClient({ fetchImpl: async () => { called = true; return Response.json({}); } });
  assert.throws(() => client.getPackument("bad/name"), /unsafe npm package/);
  assert.throws(() => client.getManifest("pi-subagents", "latest"), /invalid exact npm version/);
  assert.equal(called, false);
});
