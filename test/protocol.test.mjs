import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decode, encode, negotiate, schema, schemaDigest } from "../src/execution/protocol.mjs";

const implementation = {
  engineRevision: "0".repeat(40), engineDigest: "1".repeat(64), bridgeDigest: "2".repeat(64),
  schemaDigest, configurationDigest: "3".repeat(64), credentialReferenceDigest: "4".repeat(64),
};
const request = () => ({ schemaVersion: 1, requestId: "request-1", body: {
  kind: "describe", expectedImplementation: structuredClone(implementation), requiredProfile: "linux-untrusted-review",
} });
const response = () => ({ schemaVersion: 1, requestId: "request-1", body: {
  kind: "capabilities", implementation: structuredClone(implementation), profiles: ["linux-untrusted-review"],
  capabilities: ["authenticated-ipc", "durable-intents", "zero-effect-reopen", "descendant-cleanup"],
} });

const fixtures = JSON.parse(readFileSync(new URL("../protocol/conformance.json", import.meta.url)));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
for (const fixture of fixtures.cases) {
  test(`shared conformance: ${fixture.name}`, () => {
    const value = structuredClone(fixtures.messages[fixture.base ?? "error"]);
    function locate(path) {
      const fields = path.split(".");
      const field = fields.pop();
      return [fields.reduce((parent, key) => parent[key], value), field];
    }
    for (const [path, replacement] of Object.entries(fixture.changes ?? {})) {
      const [parent, field] = locate(path);
      parent[field] = replacement;
    }
    if (fixture.remove) {
      const [parent, field] = locate(fixture.remove);
      delete parent[field];
    }
    const bytes = Buffer.from(fixture.raw ?? canonical(value));
    if (fixture.accepted) assert.deepEqual(Buffer.from(encode(decode(bytes))), bytes);
    else assert.throws(() => decode(bytes), { code: fixture.code ?? fixtures.rejectionCodeDefault });
  });
}

test("transferred discovery contract preserves exact schema bytes", () => {
  const bytes = readFileSync(new URL("../protocol/execution.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), schemaDigest);
  assert.equal(schemaDigest, "dfaae881ef6cab2981ff63a3d478af684b49ec691192e3bd8981fe77a61e72a3");
  assert.deepEqual(decode(encode(request())), request());
  negotiate(request(), response(), []);
});

test("discovery remains bound to source, request, profile and mandatory guarantees", () => {
  for (const field of Object.keys(implementation)) {
    const wrong = response();
    wrong.body.implementation[field] = "a".repeat(field === "engineRevision" ? 40 : 64);
    assert.throws(() => negotiate(request(), wrong, []), { code: "custody-lost" });
  }
  const wrong = response();
  wrong.requestId = "other";
  assert.throws(() => negotiate(request(), wrong, []), { code: "transport-failed" });
  for (const missing of response().body.capabilities) {
    const value = response();
    value.body.capabilities = value.body.capabilities.filter(c => c !== missing);
    assert.throws(() => negotiate(request(), value, []), { code: "unsupported-capability" });
  }
  const unsupported = request();
  unsupported.body.requiredProfile = "macos-untrusted-review";
  assert.throws(() => negotiate(unsupported, response(), []), { code: "unsupported-profile" });
});

test("schema metadata is immutable and malformed frames cannot change its limits", () => {
  assert.equal(Reflect.set(schema, "maxFrameBytes", Infinity), false);
  assert.equal(Reflect.set(schema.definitions.Id, "maxBytes", Infinity), false);
  const value = request();
  value.requestId = "🧪".repeat(65);
  assert.throws(() => encode(value), { code: "invalid-frame" });
  for (const bytes of [new Uint8Array(65537), Buffer.from([255]), Buffer.from('{"schemaVersion":1,"schemaVersion":1}')]) {
    assert.throws(() => decode(bytes), { code: "invalid-frame" });
  }
});

test("accessor-backed messages are validated and emitted from one snapshot", () => {
  const value = request();
  let reads = 0;
  Object.defineProperty(value, "requestId", { enumerable: true, get: () => ++reads === 1 ? "ok" : "bad\nvalue" });
  assert.equal(decode(encode(value)).requestId, "ok");
});
