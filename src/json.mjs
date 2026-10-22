import limits from "../protocol/transport.json" with { type: "json" };
import { types } from "node:util";

Object.freeze(limits);

/** Serialize only JSON data; bound bytes while walking, before allocating a body.
 * Accessors, toJSON hooks, sparse arrays and non-data prototypes are rejected.
 */
export function encodeJson(value, maximum) {
  const chunks = [];
  const active = new Set();
  let size = 0;
  function append(text) {
    size += Buffer.byteLength(text);
    if (size > maximum) throw new RangeError("input-limit");
    chunks.push(text);
  }
  function visit(value, depth) {
    if (depth > limits.maxJsonDepth) throw new TypeError("invalid-options");
    if (value === null || typeof value === "boolean") { append(String(value)); return; }
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > maximum - size) throw new RangeError("input-limit");
      append(JSON.stringify(value)); return;
    }
    if (typeof value === "number" && Number.isFinite(value)) { append(JSON.stringify(value)); return; }
    if (typeof value !== "object" || active.has(value) || types.isProxy(value)) throw new TypeError("invalid-options");
    const array = Array.isArray(value);
    if (![array ? Array.prototype : Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("invalid-options");
    active.add(value);
    append(array ? "[" : "{");
    // Array iteration methods are caller-overridable. Read only own data slots.
    const keys = array ? undefined : Object.keys(value);
    const length = array ? value.length : keys.length;
    for (let index = 0; index < length; index++) {
      const key = array ? index : keys[index];
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !Object.hasOwn(field, "value")) throw new TypeError("invalid-options");
      if (index) append(",");
      if (!array) {
        if (Buffer.byteLength(key) > maximum - size) throw new RangeError("input-limit");
        append(JSON.stringify(key)); append(":");
      }
      visit(field.value, depth + 1);
    }
    append(array ? "]" : "}");
    active.delete(value);
  }
  visit(value, 0);
  return Buffer.from(chunks.join(""));
}

/** Bounded JSON with duplicate-key and nesting rejection, before JSON.parse. */
export function parseJson(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0;
  const space = () => { while (/[\t\r\n ]/.test(text[at] ?? "x")) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") { at += 2; continue; }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error("invalid-json");
  }
  function value(depth) {
    if (depth > limits.maxJsonDepth) throw new Error("invalid-json");
    space();
    if (text[at] === '"') { string(); return; }
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{";
      const end = object ? "}" : "]";
      const keys = new Set();
      space();
      if (text[at] === end) { at++; return; }
      for (;;) {
        if (object) {
          space();
          if (text[at] !== '"') throw new Error("invalid-json");
          const key = string();
          if (keys.has(key)) throw new Error("invalid-json");
          keys.add(key);
          space();
          if (text[at++] !== ":") throw new Error("invalid-json");
        }
        value(depth + 1);
        space();
        const delimiter = text[at++];
        if (delimiter === end) return;
        if (delimiter !== ",") throw new Error("invalid-json");
      }
    }
    const start = at;
    while (at < text.length && !/[\t\r\n ,\]}]/.test(text[at])) at++;
    if (at === start) throw new Error("invalid-json");
  }
  value(0);
  space();
  if (at !== text.length) throw new Error("invalid-json");
  return JSON.parse(text);
}
