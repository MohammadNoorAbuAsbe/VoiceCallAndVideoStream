// ─────────────────────────────────────────────────────────────────────────────
//  Crypto — cryptographic identity + end-to-end encryption primitives.
//
//  Identity : each user holds an Ed25519 signing keypair. Their peer ID is
//             derived from the public key (id = base32(SHA-256(pubKey)[:12])),
//             so an ID is unforgeable — you can only "own" it if you hold the
//             matching private key. Registration proves possession by signing a
//             server challenge (see relay.js / server.js).
//
//  E2E      : each call performs an authenticated X25519 ECDH. Both ephemeral
//             public keys are signed by the identity key (verified against the
//             peer's ID fingerprint), which prevents the relay from mounting a
//             man-in-the-middle attack. The shared secret is expanded via
//             HKDF-SHA256 into two AES-GCM keys (one per direction), so the
//             relay only ever forwards opaque ciphertext.
//
//  Uses the standard Web Crypto API (`crypto.subtle`), available in the Tauri
//  WebView (Chromium) and in Node ≥ 20 for the test suite.
// ─────────────────────────────────────────────────────────────────────────────

const g = globalThis;
// Use the platform Web Crypto (Chromium WebView / modern Node). In Node < 20
// where `globalThis.crypto` is absent, fall back to the built-in webcrypto.
const _crypto = g.crypto || (typeof require !== 'undefined' ? require('node:crypto').webcrypto : null);
const subtle = _crypto.subtle;
const gGetRandomValues = (arr) => _crypto.getRandomValues(arr);
// btoa/atob are present in browsers and Node ≥ 16; guard for older Node.
function _btoa(s) { return (g.btoa || ((x) => Buffer.from(x, 'binary').toString('base64')))(s); }
function _atob(s) { return (g.atob || ((x) => Buffer.from(x, 'base64').toString('binary')))(s); }
const enc = new TextEncoder();

// ─── base64 / base32 helpers (binary-safe, environment-agnostic) ─────────────
export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return _btoa(bin);
}
export function b64ToBytes(b64) {
  const bin = _atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function bytesToB32(bytes) {
  let out = '', bits = 0, value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// ─── Identity fingerprint (ID derivation) ────────────────────────────────────
// The peer ID is the base32 of the first 12 bytes of SHA-256(publicKey): a
// short (20-char), shareable, and unforgeable identifier.
export async function fingerprint(publicKeyB64) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', b64ToBytes(publicKeyB64)));
  return bytesToB32(digest.slice(0, 12));
}

// ─── Identity keypair (Ed25519) ──────────────────────────────────────────────
// Generate a fresh identity: an Ed25519 keypair plus its derived ID.
export async function generateIdentity() {
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyB64  = bytesToB64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const privateKeyB64 = bytesToB64(new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey)));
  return loadIdentity(publicKeyB64, privateKeyB64);
}

// Rehydrate an identity previously produced by generateIdentity().
export async function loadIdentity(publicKeyB64, privateKeyB64) {
  const signingPub  = await subtle.importKey('raw',   b64ToBytes(publicKeyB64),  { name: 'Ed25519' }, true, ['verify']);
  const signingPriv = await subtle.importKey('pkcs8', b64ToBytes(privateKeyB64), { name: 'Ed25519' }, true, ['sign']);
  const id = await fingerprint(publicKeyB64);
  return {
    id,
    publicKeyB64,
    privateKeyB64,
    signingPub,
    signingPriv,
    // Sign arbitrary bytes with this identity's private key.
    async sign(bytes) {
      return bytesToB64(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, signingPriv, bytes)));
    },
  };
}

// Verify a signature (base64) over `bytes` against a public key (base64).
export async function verify(publicKeyB64, sigB64, bytes) {
  try {
    const pub = await subtle.importKey('raw', b64ToBytes(publicKeyB64), { name: 'Ed25519' }, true, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, pub, b64ToBytes(sigB64), bytes);
  } catch {
    return false;
  }
}

// ─── End-to-end call session (authenticated X25519 ECDH → AES-GCM) ───────────
function transcript(ephPubB64, callId) {
  return enc.encode(ephPubB64 + '|' + callId);
}

async function deriveDirectionalKeys(sharedBits, callId) {
  const base = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const mk = (info) => subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(callId), info: enc.encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { a2b: await mk('a2b'), b2a: await mk('b2a') }; // a = initiator, b = responder
}

// A CallSession encrypts/decrypts audio frames for a single call. Each side
// encrypts with its own directional key (no cross-direction nonce reuse) and a
// per-session random nonce prefix + monotonic counter.
export class CallSession {
  constructor(isInitiator) {
    this.isInitiator = isInitiator;
    this.sendKey = null;
    this.recvKey = null;
    this._noncePrefix = gGetRandomValues(new Uint8Array(4));
    this._counter = 0n;
    this._peerId = null;
    this._callId = null;
    this._eph = null;      // our ephemeral X25519 keypair
    this._ephPubB64 = null;
  }

  async _makeEphemeral() {
    this._eph = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    this._ephPubB64 = bytesToB64(new Uint8Array(await subtle.exportKey('raw', this._eph.publicKey)));
  }

  async _deriveWith(peerEphPubB64) {
    const peerPub = await subtle.importKey('raw', b64ToBytes(peerEphPubB64), { name: 'X25519' }, true, []);
    const bits = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peerPub }, this._eph.privateKey, 256));
    const { a2b, b2a } = await deriveDirectionalKeys(bits, this._callId);
    if (this.isInitiator) { this.sendKey = a2b; this.recvKey = b2a; }
    else                  { this.sendKey = b2a; this.recvKey = a2b; }
  }

  get ready() { return !!(this.sendKey && this.recvKey); }

  // Caller side: build the signed key-exchange offer sent in `call`.
  static async initiator(identity, peerId, callId) {
    const s = new CallSession(true);
    s._peerId = peerId; s._callId = callId;
    await s._makeEphemeral();
    const sig = await identity.sign(transcript(s._ephPubB64, callId));
    return { session: s, offer: { idPub: identity.publicKeyB64, ephPub: s._ephPubB64, sig } };
  }

  // Callee side: verify the caller's offer, derive keys, return the signed answer.
  static async responder(identity, peerId, callId, offer) {
    if (!offer || (await fingerprint(offer.idPub)) !== peerId) throw new Error('peer identity mismatch');
    if (!(await verify(offer.idPub, offer.sig, transcript(offer.ephPub, callId)))) throw new Error('bad offer signature');
    const s = new CallSession(false);
    s._peerId = peerId; s._callId = callId;
    await s._makeEphemeral();
    await s._deriveWith(offer.ephPub);
    const sig = await identity.sign(transcript(s._ephPubB64, callId));
    return { session: s, answer: { idPub: identity.publicKeyB64, ephPub: s._ephPubB64, sig } };
  }

  // Caller side: verify the callee's answer and complete key derivation.
  async completeInitiator(answer) {
    if (!answer || (await fingerprint(answer.idPub)) !== this._peerId) throw new Error('peer identity mismatch');
    if (!(await verify(answer.idPub, answer.sig, transcript(answer.ephPub, this._callId)))) throw new Error('bad answer signature');
    await this._deriveWith(answer.ephPub);
  }

  // Encrypt one frame → wire bytes: [12-byte nonce][AES-GCM ciphertext+tag].
  async encrypt(plaintext) {
    const nonce = new Uint8Array(12);
    nonce.set(this._noncePrefix, 0);
    new DataView(nonce.buffer).setBigUint64(4, this._counter++, false);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, this.sendKey, plaintext));
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce, 0); out.set(ct, 12);
    return out;
  }

  // Decrypt wire bytes (nonce is embedded) → plaintext bytes.
  async decrypt(wire) {
    const bytes = wire instanceof Uint8Array ? wire : new Uint8Array(wire);
    const nonce = bytes.subarray(0, 12);
    const ct = bytes.subarray(12);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, this.recvKey, ct));
  }
}
