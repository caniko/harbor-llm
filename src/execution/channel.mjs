import contract from "../../protocol/channel.json" with { type: "json" };
import { encode, decode, schemaDigest } from "./protocol.mjs";
import { AuthenticatedRecords } from "./records.mjs";

Object.freeze(contract);

/** Integrity/authentication for private local channels; no encryption or admission.
 * Trusted launch supplies a fresh random nonce, 256-bit secret and exact binding.
 * Never reuse the key/nonce/binding tuple, including across process restarts.
 */
export class AuthenticatedChannel {
  #records;

  constructor({ key, nonce, binding, role }) {
    this.#records = new AuthenticatedRecords({ key, nonce, binding, role }, { domain: contract.domain, schemaDigest });
  }

  /** Authenticate exactly one outgoing canonical message. No automatic retries. */
  seal(message) {
    try {
      this.#records.ready();
      return this.#records.seal(encode(message));
    } catch (error) { this.close(); throw error; }
  }

  /** Reject altered, reflected, replayed or out-of-order records before decoding. */
  open(bytes) {
    try {
      return decode(this.#records.open(bytes));
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    this.#records.close();
  }
}
