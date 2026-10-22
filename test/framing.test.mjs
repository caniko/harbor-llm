import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameDecoder, frame } from "../src/execution/framing.mjs";

const message = { schemaVersion: 1, requestId: "frame-🧪", body: { kind: "error", code: "effect-unknown" } };

test("length-prefixed protocol survives every possible header/body split", () => {
  const bytes = frame(message);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new FrameDecoder();
    assert.deepEqual([...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))], [message]);
    decoder.end();
  }
});

test("coalesced messages have independent frame boundaries", () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([frame(message), frame(message)])), [message, message]);
  decoder.end();
});

test("zero/oversized length, malformed body and truncated stream permanently poison a reader", () => {
  for (const bytes of [Buffer.from([0, 0, 0, 0]), Buffer.from([0, 1, 0, 1]), Buffer.from([0, 0, 0, 1, 255])]) {
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push(bytes), { code: "invalid-frame" });
    assert.throws(() => decoder.push(frame(message)), { code: "transport-failed" });
  }
  for (const end of [1, 3, 5]) {
    const decoder = new FrameDecoder();
    decoder.push(frame(message).subarray(0, end));
    assert.throws(() => decoder.end(), { code: "transport-failed" });
    assert.throws(() => decoder.push(frame(message)), { code: "transport-failed" });
  }
});
