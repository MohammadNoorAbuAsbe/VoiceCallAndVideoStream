// ─────────────────────────────────────────────────────────────────────────────
//  VoiceCall Relay Server
//
//  A tiny WebSocket relay. Clients connect outbound (works through any NAT /
//  firewall — no ICE / TURN / WebRTC needed). The server maps a peer "id" to a
//  socket, forwards call-signaling messages, and shuttles raw binary audio
//  frames between the two peers in a call. It never sees plaintext: audio is
//  end-to-end encrypted by the clients, and the key-exchange payloads it
//  forwards are opaque.
//
//  Identity is unforgeable: a peer ID is the fingerprint of the client's
//  Ed25519 public key, and registration requires signing a server challenge, so
//  a client can only register an ID it actually owns.
//
//  Protocol (JSON unless marked binary):
//    Client → Server
//      register {id, pubKey, token?}   → server replies `challenge`
//      auth     {sig}                  → signature over the challenge nonce
//      call     {to, callId, offer}    (offer = signed X25519 key exchange)
//      accept   {callId, to, answer}   (answer = signed X25519 key exchange)
//      reject   {callId, to}
//      cancel   {callId, to}
//      hangup   {callId, to}
//      reconnect{callId, to}
//      mute     {to, muted}
//      ping
//      <binary>                        → encrypted audio frame (forwarded)
//    Server → Client
//      challenge {nonce}
//      registered {id}
//      register-denied {reason}
//      id-taken   {id}
//      incoming   {from, callId, offer}
//      accepted   {callId, from, answer}
//      rejected / cancelled / ended / busy / peer-unavailable {callId}
//      reconnecting / reconnected {callId}
//      muted      {from, muted}
//      pong
//
//  Env:
//    PORT        (default 3000)
//    RELAY_TOKEN (optional; if set, clients must register with the same token)
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { webcrypto } from 'node:crypto';
import { WebSocketServer } from 'ws';

const subtle = webcrypto.subtle;
const PORT = Number(process.env.PORT) || 3000;
/* v8 ignore next */
const TOKEN = process.env.RELAY_TOKEN || '';

// ─── Identity verification helpers (mirror src/crypto.js) ────────────────────
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
// Derive the canonical peer ID from an Ed25519 public key (base64).
async function fingerprint(pubKeyB64) {
  const raw = Buffer.from(pubKeyB64, 'base64');
  const digest = new Uint8Array(await subtle.digest('SHA-256', raw));
  return bytesToB32(digest.slice(0, 12));
}
// Verify an Ed25519 signature (base64) over `bytes` against a public key (base64).
async function verifySig(pubKeyB64, sigB64, bytes) {
  try {
    const pub = await subtle.importKey('raw', Buffer.from(pubKeyB64, 'base64'), { name: 'Ed25519' }, true, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, pub, Buffer.from(sigB64, 'base64'), bytes);
  } catch {
    return false;
  }
}

// Minimal HTTP server so platforms like Render can health-check the service.
// The WebSocket server upgrades the same HTTP listener.
const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404);
    res.end();
  }
});

// perMessageDeflate: small PCM audio frames gain nothing from zlib and pay a
// per-frame CPU cost, so disable it. setNoDelay (below) disables Nagle so each
// audio frame is flushed immediately instead of being held for coalescing —
// this is the single biggest in-app latency win for the relay.
const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });

/** id → ws */
const clients = new Map();
/** callId → { a, b, accepted, dropTimer } */
const calls = new Map();

const isOpen = (ws) => ws && ws.readyState === ws.OPEN;
function send(ws, obj) {
  if (isOpen(ws)) ws.send(JSON.stringify(obj));
}
function sendBin(ws, data) {
  if (isOpen(ws)) ws.send(data);
}

// Wire the per-connection protocol handlers onto a WebSocketServer.
export function attachRelay(server) {
  server.on('connection', (ws) => {
    // Flush every WebSocket frame the moment it's written — Nagle's algorithm
    // would otherwise buffer small audio frames for up to ~40 ms waiting to
    // coalesce them, adding that delay on top of every hop through the relay.
    try { ws._socket.setNoDelay(true); } catch { /* no-op */ }
    ws.isAlive = true;
    ws.id = null;              // registered id (set only after successful auth)
    ws.pendingAuth = null;     // { id, pubKey, nonce } awaiting a signed challenge
    ws.currentCall = null;     // callId of the active call (set after accept)
    ws.pendingOutgoing = null; // { to, callId } of an unanswered outgoing call

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
      if (isBinary) { handleAudio(ws, data); return; }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      handleMessage(ws, msg);
    });

    ws.on('close', () => handleClose(ws));
    ws.on('error', () => { /* ignore transport errors */ });
  });
  return server;
}

attachRelay(wss);

// Dispatch incoming signaling messages by type.
async function handleMessage(ws, m) {
  switch (m.t) {
    // Step 1 of registration: client presents its id + public key. We verify
    // the id is the key's fingerprint, then issue a random challenge.
    case 'register': {
      if (TOKEN && m.token !== TOKEN) { send(ws, { t: 'register-denied', reason: 'token' }); ws.close(); return; }
      const id = String(m.id || '').trim();
      const pubKey = String(m.pubKey || '');
      if (!id || !pubKey) { send(ws, { t: 'register-denied', reason: 'missing' }); return; }
      if ((await fingerprint(pubKey)) !== id) { send(ws, { t: 'register-denied', reason: 'id-mismatch' }); return; }
      if (clients.has(id)) { send(ws, { t: 'id-taken', id }); return; }
      const nonce = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
      ws.pendingAuth = { id, pubKey, nonce };
      send(ws, { t: 'challenge', nonce });
      break;
    }

    // Step 2 of registration: client returns a signature over the challenge
    // nonce, proving it holds the private key for the claimed id.
    case 'auth': {
      const pending = ws.pendingAuth;
      if (!pending) { send(ws, { t: 'register-denied', reason: 'no-challenge' }); return; }
      const ok = await verifySig(pending.pubKey, String(m.sig || ''), Buffer.from(pending.nonce, 'base64'));
      if (!ok) { send(ws, { t: 'register-denied', reason: 'bad-signature' }); ws.close(); return; }
      // A reconnect from the same identity (same public key) evicts the stale
      // socket; a different key claiming an already-online id is rejected.
      const existing = clients.get(pending.id);
      if (existing && existing.pubKey !== pending.pubKey) { send(ws, { t: 'id-taken', id: pending.id }); return; }
      if (existing && existing !== ws) { try { existing.close(); } catch { /* noop */ } clients.delete(pending.id); }
      ws.id = pending.id;
      ws.pubKey = pending.pubKey;
      ws.pendingAuth = null;
      clients.set(ws.id, ws);
      send(ws, { t: 'registered', id: ws.id });
      console.log(`[+] ${ws.id} registered (${clients.size} online)`);
      break;
    }

    case 'call': {
      const { to, callId, offer } = m;
      if (!ws.id) return;
      if (to === ws.id) return; // can't call yourself
      const target = clients.get(to);
      if (!target) { send(ws, { t: 'peer-unavailable', callId }); return; }
      if (target.currentCall) { send(ws, { t: 'busy', callId }); return; }
      ws.pendingOutgoing = { to, callId };
      send(target, { t: 'incoming', from: ws.id, callId, offer });
      break;
    }

    case 'accept': {
      const { callId, to, answer } = m;
      const caller = clients.get(to);
      if (!caller) { send(ws, { t: 'peer-unavailable', callId }); return; }
      calls.set(callId, { a: ws.id, b: to, accepted: true, dropTimer: null });
      ws.currentCall = callId;
      caller.currentCall = callId;
      ws.pendingOutgoing = null;
      caller.pendingOutgoing = null;
      send(caller, { t: 'accepted', callId, from: ws.id, answer });
      break;
    }

    case 'reject': {
      const { callId, to } = m;
      if (ws.pendingOutgoing && ws.pendingOutgoing.callId === callId) ws.pendingOutgoing = null;
      const caller = clients.get(to);
      if (caller) send(caller, { t: 'rejected', callId });
      break;
    }

    case 'cancel': {
      const { callId, to } = m;
      ws.pendingOutgoing = null;
      const callee = clients.get(to);
      if (callee) send(callee, { t: 'cancelled', callId });
      break;
    }

    case 'hangup': {
      endCall(m.callId, ws.id, 'ended');
      break;
    }

    case 'reconnect': {
      const { callId, to } = m;
      const call = calls.get(callId);
      const peer = clients.get(to);
      if (!call || !peer) { send(ws, { t: 'peer-unavailable', callId }); return; }
      ws.currentCall = callId;
      peer.currentCall = callId;
      if (call.dropTimer) { clearTimeout(call.dropTimer); call.dropTimer = null; }
      send(ws, { t: 'reconnected', callId });
      send(peer, { t: 'reconnected', callId });
      break;
    }

    case 'mute': {
      const { to, muted } = m;
      const peer = clients.get(to);
      if (peer) send(peer, { t: 'muted', from: ws.id, muted });
      break;
    }

    case 'ping':
      send(ws, { t: 'pong' });
      break;

    default:
      break;
  }
}

// Forward an (encrypted) binary audio frame from one peer to the other.
function handleAudio(ws, data) {
  const callId = ws.currentCall;
  if (!callId) return;
  const call = calls.get(callId);
  if (!call) return;
  const peerId = call.a === ws.id ? call.b : call.a;
  sendBin(clients.get(peerId), data);
}

// Tear down a call, remove it from the map, and notify both peers.
function endCall(callId, byId, reason) {
  const call = calls.get(callId);
  if (!call) return;
  calls.delete(callId);
  for (const pid of [call.a, call.b]) {
    const c = clients.get(pid);
    if (c) {
      c.currentCall = null;
      c.pendingOutgoing = null;
      send(c, { t: reason, callId });
    }
  }
}

// On disconnect, notify the peer and hold the call open for a 30s grace window
// so the dropped side can reconnect and resume.
function handleClose(ws) {
  const id = ws.id;
  if (!id) return;
  clients.delete(id);
  console.log(`[-] ${id} disconnected (${clients.size} online)`);
  const callId = ws.currentCall;
  if (!callId) return;
  const call = calls.get(callId);
  if (!call) return;
  const peerId = call.a === id ? call.b : call.a;
  const peer = clients.get(peerId);
  if (peer) {
    send(peer, { t: 'reconnecting', callId });
    call.dropTimer = setTimeout(() => {
      calls.delete(callId);
      if (peer) { peer.currentCall = null; send(peer, { t: 'ended', callId }); }
    }, 30000);
  }
}

// Heartbeat: drop sockets that stop responding.
/* v8 ignore next 7 */
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// ── Lifecycle (start/stop) ────────────────────────────────────────────────────
// `listen` is split out so tests can start the relay on an ephemeral port and
// tear it down, without the module binding a fixed port on import.
export function startServer(port = PORT) {
  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const addr = httpServer.address();
      console.log(`VoiceCall relay listening on :${addr.port}${TOKEN ? ' (token required)' : ''}`);
      resolve(addr.port);
    });
  });
}

export function stopServer() {
  clearInterval(heartbeat);
  return new Promise((resolve) => {
    wss.close();
    httpServer.close(() => resolve());
  });
}

export { httpServer, wss, clients, calls, handleMessage, handleAudio, endCall, handleClose, fingerprint, verifySig };

// Only auto-start when executed directly (`node server.js`), not on import.
const isRunDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
/* v8 ignore next 3 */
if (isRunDirectly) {
  startServer();
}
