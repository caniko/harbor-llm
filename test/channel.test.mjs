import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthenticatedChannel } from "../src/execution/channel.mjs";

const key = Buffer.alloc(32, 1), nonce = Buffer.alloc(32, 2), binding = Buffer.alloc(32, 3);
const message = { schemaVersion: 1, requestId: "request-🧪", body: { kind: "error", code: "effect-unknown" } };
const peer = (role, options = {}) => new AuthenticatedChannel({ key, nonce, binding, role, ...options });

test("the predecessor v1 authenticated record bytes remain identical", () => {
  assert.equal(peer("controller").seal(message).toString("hex"), "00000000000000010000005e7b22626f6479223a7b22636f6465223a226566666563742d756e6b6e6f776e222c226b696e64223a226572726f72227d2c22726571756573744964223a22726571756573742df09fa7aa222c22736368656d6156657273696f6e223a317d36f580b3b6ab6f65ab98598d60ee00ddfcb3077db0d0b763a3dae4ee061ae51b");
});

test("authenticated channel binds both directions and successive sequence numbers", () => {
  const controller = peer("controller"), bridge = peer("bridge");
  for (let n = 0; n < 3; n++) {
    assert.deepEqual(bridge.open(controller.seal(message)), message);
    assert.deepEqual(controller.open(bridge.seal(message)), message);
  }
  controller.close(); bridge.close();
});

test("wrong authority key, channel, binding or role rejects before delivering any message", () => {
  for (const changes of [{ key: Buffer.alloc(32, 4) }, { nonce: Buffer.alloc(32, 4) }, { binding: Buffer.alloc(32, 4) }, { role: "controller" }]) {
    const receiver = peer("bridge", changes), sender = peer("controller");
    assert.throws(() => receiver.open(sender.seal(message)), { code: "authority-denied" });
    assert.throws(() => receiver.seal(message), { code: "transport-failed" });
  }
});

test("every mutated byte, truncation, trailing byte, replay and reorder poisons the channel", () => {
  const record = peer("controller").seal(message);
  for (let at = 0; at < record.length; at++) {
    const altered = Buffer.from(record); altered[at] ^= 1;
    assert.throws(() => peer("bridge").open(altered));
  }
  for (let end = 0; end < record.length; end++) assert.throws(() => peer("bridge").open(record.subarray(0, end)));
  assert.throws(() => peer("bridge").open(Buffer.concat([record, Buffer.from([0])])));
  const receiver = peer("bridge");
  receiver.open(record);
  assert.throws(() => receiver.open(record), { code: "authority-denied" });
  const sender = peer("controller"); sender.seal(message);
  assert.throws(() => peer("bridge").open(sender.seal(message)), { code: "authority-denied" });
});

test("key material is copied privately and disposal is terminal", () => {
  const mutable = Buffer.from(key), controller = peer("controller", { key: mutable });
  mutable.fill(0);
  assert.deepEqual(peer("bridge").open(controller.seal(message)), message);
  controller.close(); controller.close();
  assert.throws(() => controller.seal(message), { code: "transport-failed" });
  assert.throws(() => controller.seal(null), { code: "transport-failed" });
  assert.throws(() => controller.open(Buffer.alloc(0)), { code: "transport-failed" });
  assert.equal(JSON.stringify(controller), "{}");
  for (const changes of [{ role: "worker" }, { nonce: Buffer.alloc(0) }, { key: "secret" }, { binding: Buffer.alloc(31) }]) {
    assert.throws(() => peer("bridge", changes), { code: "authority-denied" });
  }
});
