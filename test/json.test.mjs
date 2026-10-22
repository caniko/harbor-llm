import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeJson, parseJson } from "../src/json.mjs";

test("array contents cannot be replaced by an overridden keys method or getter", () => {
  let calls = 0;
  for (const descriptor of [
    { value() { calls++; return [][Symbol.iterator](); } },
    { get() { calls++; throw new Error("caller hook"); } },
  ]) {
    const input = ["real", { nested: [false, null, "🧪"] }];
    Object.defineProperty(input, "keys", descriptor);
    assert.deepEqual(parseJson(encodeJson(input, 1024)), ["real", { nested: [false, null, "🧪"] }]);
  }
  assert.equal(calls, 0);
});

test("array holes and accessor elements reject without invoking the accessor", () => {
  let calls = 0;
  const accessor = ["real"];
  Object.defineProperty(accessor, "0", { get() { calls++; return "replacement"; } });
  for (const input of [new Array(1), ["real", , "tail"], accessor]) {
    assert.throws(() => encodeJson(input, 1024), TypeError);
  }
  assert.equal(calls, 0);
});

test("proxy inputs reject before caller traps can run", () => {
  let calls = 0;
  const traps = {
    get() { calls++; throw new Error("caller hook"); },
    getPrototypeOf() { calls++; return Object.prototype; },
    ownKeys() { calls++; return []; },
    getOwnPropertyDescriptor() { calls++; return undefined; },
  };
  for (const input of [new Proxy({}, traps), new Proxy(["real"], traps)]) {
    assert.throws(() => encodeJson(input, 1024), TypeError);
  }
  assert.equal(calls, 0);
});

test("array serialization retains byte bounds and rejects non-data prototypes", () => {
  assert.equal(encodeJson(["🧪"], 8).toString(), '["🧪"]');
  assert.throws(() => encodeJson(["🧪"], 7), { message: "input-limit" });
  class CustomArray extends Array {}
  assert.throws(() => encodeJson(new CustomArray("real"), 1024), TypeError);
  const input = ["real"];
  Object.setPrototypeOf(input, null);
  assert.equal(encodeJson(input, 1024).toString(), '["real"]');
});
