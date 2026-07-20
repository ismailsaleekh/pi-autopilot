import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { CoordinationRuntimeError } from "./failures.js";
// D65-A2/A3 trust bootstrap (§9.3). The operator trust anchor is the ONE
// explicitly frozen BINARY contract: exactly 44 bytes of canonical DER Ed25519
// SubjectPublicKeyInfo `302a300506032b6570032100 || <32 raw public-key bytes>`,
// OID 1.3.101.112, absent parameters, zero unused bits, no wrapper/PEM/trailing
// LF/alternate DER encoding. Everything signed under D65 uses this one key with
// mandatory domain-separated signed bytes; signatures are unpadded base64url of
// exactly 64 Ed25519 bytes over RFC 8785 JSON without the `signature` field,
// prefixed by the purpose-domain literal.
/** The exact 12-byte canonical Ed25519 SPKI DER prefix. */
export const D65_ED25519_SPKI_PREFIX = Uint8Array.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
export const D65_ED25519_SPKI_BYTE_COUNT = 44;
export const D65_ED25519_RAW_KEY_BYTE_COUNT = 32;
export const D65_ED25519_SIGNATURE_BYTE_COUNT = 64;
/** The five mandatory domain-separation literals (each NUL-terminated). */
export const D65_SIGNATURE_DOMAINS = {
    'launch-policy': 'AUTOPILOT-D65-LAUNCH-POLICY\u0000',
    'capacity-decision': 'AUTOPILOT-D65-CAPACITY-DECISION\u0000',
    'subscription-probe': 'AUTOPILOT-D65-SUBSCRIPTION-PROBE\u0000',
    'program-heartbeat': 'AUTOPILOT-D65-PROGRAM-HEARTBEAT\u0000',
    'parent-loss': 'AUTOPILOT-D65-PARENT-LOSS\u0000',
};
const BASE64URL_UNPADDED = /^[A-Za-z0-9_-]+$/u;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function bytesEqual(left, right) {
    if (left.byteLength !== right.byteLength)
        return false;
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index])
            return false;
    }
    return true;
}
/**
 * Decode an unpadded RFC 4648 base64url string to bytes. Returns null when the
 * input is not exactly canonical unpadded base64url (padding, alias chars, or a
 * non-canonical final group all reject).
 */
export function decodeUnpaddedBase64Url(value) {
    if (typeof value !== 'string' || value.length === 0 || !BASE64URL_UNPADDED.test(value))
        return null;
    if (value.length % 4 === 1)
        return null;
    const out = [];
    let buffer = 0;
    let bits = 0;
    for (const char of value) {
        const digit = BASE64URL_ALPHABET.indexOf(char);
        if (digit < 0)
            return null;
        buffer = (buffer << 6) | digit;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buffer >> bits) & 0xff);
        }
    }
    // Any residual bits must be zero for a canonical unpadded encoding.
    if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0)
        return null;
    return Uint8Array.from(out);
}
/** Encode bytes as unpadded RFC 4648 base64url. */
export function encodeUnpaddedBase64Url(bytes) {
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += BASE64URL_ALPHABET[(buffer >> bits) & 0x3f];
        }
    }
    if (bits > 0)
        out += BASE64URL_ALPHABET[(buffer << (6 - bits)) & 0x3f];
    return out;
}
/**
 * Parse the frozen 44-byte Ed25519 SPKI trust anchor. Rejects wrong OID, DER
 * form, byte count, unused bits, wrapper, PEM, or trailing bytes; there is no
 * fallback parser.
 */
export function parseD65TrustAnchorSpki(bytes) {
    if (!(bytes instanceof Uint8Array))
        throw new CoordinationRuntimeError('invalid-state', 'trust anchor bytes must be a byte buffer');
    if (bytes.byteLength !== D65_ED25519_SPKI_BYTE_COUNT)
        throw new CoordinationRuntimeError('invalid-state', `trust anchor must be exactly ${String(D65_ED25519_SPKI_BYTE_COUNT)} canonical SPKI bytes`, [`bytes=${String(bytes.byteLength)}`]);
    for (let index = 0; index < D65_ED25519_SPKI_PREFIX.length; index += 1) {
        if (bytes[index] !== D65_ED25519_SPKI_PREFIX[index])
            throw new CoordinationRuntimeError('invalid-state', 'trust anchor SPKI prefix is not the canonical Ed25519 DER header');
    }
    const spki = Uint8Array.from(bytes);
    let publicKey;
    try {
        publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    }
    catch (error) {
        throw new CoordinationRuntimeError('invalid-state', 'trust anchor SPKI is not a decodable Ed25519 public key', [error instanceof Error ? error.message : String(error)]);
    }
    if (publicKey.asymmetricKeyType !== 'ed25519')
        throw new CoordinationRuntimeError('invalid-state', 'trust anchor key type must be ed25519');
    // Re-export and require byte-identity so no alternate DER encoding is accepted.
    const reexported = publicKey.export({ format: 'der', type: 'spki' });
    if (reexported.byteLength !== D65_ED25519_SPKI_BYTE_COUNT || !bytesEqual(reexported, spki))
        throw new CoordinationRuntimeError('invalid-state', 'trust anchor SPKI is not the canonical minimal DER encoding');
    return { spki, sha256: sha256Hex(spki), publicKey };
}
/** `sha256:<64 lowercase hex>` of arbitrary bytes. */
export function sha256Hex(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/**
 * Verify an unpadded base64url Ed25519 signature over the purpose-domain
 * literal followed by the given message bytes. Returns true only on an exact
 * 64-byte signature that validates against the trust anchor.
 */
export function verifyD65Signature(input) {
    const signatureBytes = decodeUnpaddedBase64Url(input.signature);
    if (signatureBytes === null || signatureBytes.byteLength !== D65_ED25519_SIGNATURE_BYTE_COUNT)
        return false;
    // Reject any signature whose canonical re-encoding differs (no padding/alias).
    if (encodeUnpaddedBase64Url(signatureBytes) !== input.signature)
        return false;
    const domainBytes = new TextEncoder().encode(D65_SIGNATURE_DOMAINS[input.purpose]);
    const signed = new Uint8Array(domainBytes.byteLength + input.message.byteLength);
    signed.set(domainBytes, 0);
    signed.set(input.message, domainBytes.byteLength);
    try {
        return edVerify(null, signed, input.trustAnchor.publicKey, signatureBytes);
    }
    catch {
        return false;
    }
}
