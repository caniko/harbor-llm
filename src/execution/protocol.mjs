/** Provider-free structural validation and discovery; grants no authority. */
import { schema, schemaDigest } from "./schema.mjs";
export { schema, schemaDigest };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Redacted machine-readable failure with no raw payload or underlying cause. */
export class ProtocolError extends Error {
  constructor(code) {
    super(`execution protocol rejected: ${code}`);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalNumbers(value, owner) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= owner.maxJsonInteger;
  if (Array.isArray(value)) return value.every(value => canonicalNumbers(value, owner));
  if (object(value)) return Object.values(value).every(value => canonicalNumbers(value, owner));
  return true;
}

function matches(value, definition, owner) {
  if (typeof definition === "string") {
    return definition === "bool" ? typeof value === "boolean" : Object.hasOwn(owner.definitions, definition) && matches(value, owner.definitions[definition], owner);
  }
  if ("const" in definition) return value === definition.const;
  if (definition.type === "string") {
    if (typeof value !== "string") return false;
    switch (definition.format) {
      case "opaque": return value.length > 0 && encoder.encode(value).length <= definition.maxBytes
        && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
      case "sha256": return /^[a-f0-9]{64}$/.test(value);
      case "hex": return value.length <= definition.maxBytes && /^(?:[a-f0-9]{2})+$/.test(value);
      case "git-revision": return /^[a-f0-9]{40}$/.test(value);
      case "uint64":
      case "generation": return /^(0|[1-9][0-9]{0,19})$/.test(value)
        && BigInt(value) <= 18446744073709551615n
        && (definition.format !== "generation" || value !== "0");
      default: return false;
    }
  }
  if (definition.enum) return definition.enum.includes(value);
  if (definition.fields) return object(value)
    && Object.keys(value).length === Object.keys(definition.fields).length
    && Object.entries(definition.fields).every(([key, field]) => Object.hasOwn(value, key) && matches(value[key], field, owner));
  if (definition.variants && definition.tag) {
    if (!object(value) || typeof value[definition.tag] !== "string" || !Object.hasOwn(definition.variants, value[definition.tag])) return false;
    const variant = definition.variants[value[definition.tag]];
    const fields = { ...value };
    delete fields[definition.tag];
    return matches(fields, variant, owner);
  }
  if (definition.items) {
    if (!Array.isArray(value) || (definition.maxItems !== undefined && value.length > definition.maxItems)) return false;
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index) || !matches(value[index], definition.items, owner)) return false;
    }
    return !definition.unique || new Set(value.map(canonical)).size === value.length;
  }
  return false;
}

function validate(value, owner) {
  if (!object(value) || value.schemaVersion !== owner.version) throw new ProtocolError("incompatible-version");
  validateDefinition(value, owner.root, owner);
}

/** Internal owner-codec seam; structural validation grants no execution authority. */
export function validateDefinition(value, definition, owner) {
  if (!matches(value, definition, owner)) throw new ProtocolError("invalid-frame");
}

/** Decode compact key-sorted JSON. Streaming transports must bound reads first. */
export function decode(bytes) {
  return decodeWithSchema(bytes, schema);
}

/** Internal canonical decoder for immutable Harbor-owned definitions. */
export function decodeWithSchema(bytes, owner) {
  if (!(bytes instanceof Uint8Array) || bytes.length > owner.maxFrameBytes) throw new ProtocolError("invalid-frame");
  let value;
  try {
    value = JSON.parse(decoder.decode(bytes));
    const encoded = encoder.encode(canonical(value));
    if (!canonicalNumbers(value, owner) || encoded.length !== bytes.length
        || encoded.some((byte, index) => byte !== bytes[index])) throw new Error();
  } catch {
    throw new ProtocolError("invalid-frame");
  }
  validate(value, owner);
  return value;
}

function capture(value) {
  try { return structuredClone(value); }
  catch { throw new ProtocolError("invalid-frame"); }
}

function captureFrame(message, owner = schema) {
  const value = capture(message);
  validate(value, owner);
  const bytes = encoder.encode(canonical(value));
  if (bytes.length > owner.maxFrameBytes) throw new ProtocolError("invalid-frame");
  return { value, bytes };
}

/** Validate and emit the same detached snapshot. */
export function encode(message) { return captureFrame(message).bytes; }

/** Internal canonical encoder for immutable Harbor-owned definitions. */
export function encodeWithSchema(message, owner) { return captureFrame(message, owner).bytes; }

/** Structural negotiation; authenticated custody remains a separate prerequisite. */
export function negotiate(request, response, required) {
  required = capture(required);
  if (!matches(required, { items: "Capability" }, schema)) throw new ProtocolError("invalid-frame");
  request = captureFrame(request).value;
  response = captureFrame(response).value;
  if (request.body.kind !== "describe" || response.body.kind !== "capabilities") throw new ProtocolError("invalid-frame");
  if (request.requestId !== response.requestId) throw new ProtocolError("transport-failed");
  if (canonical(response.body.implementation) !== canonical(request.body.expectedImplementation)
      || request.body.expectedImplementation.schemaDigest !== schemaDigest) throw new ProtocolError("custody-lost");
  if (request.body.requiredProfile === "macos-untrusted-review" || !response.body.profiles.includes(request.body.requiredProfile)) throw new ProtocolError("unsupported-profile");
  const mandatory = ["authenticated-ipc", "durable-intents", "zero-effect-reopen", "descendant-cleanup"];
  if ([...mandatory, ...required].some(capability => !response.body.capabilities.includes(capability))) throw new ProtocolError("unsupported-capability");
}
