// ─────────────────────────────────────────────────────────────────────────────
//  Relay server protocol tests.
//
//  We start the REAL server on an ephemeral port and connect real `ws` clients,
//  then exercise the full signaling + audio-forwarding protocol end to end.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startServer, stopServer, clients, calls } from '../server.js';
import { generateIdentity, CallSession, fingerprint } from '../../src/crypto.js';

let port;
let baseUrl;
const created = [];

beforeAll(async () => {
  port = await startServer(0);
  baseUrl = `ws://127.0.0.1:${port}`;
});
afterAll(async () => {
  await stopServer();
});
afterEach(async () => {
  for (const c of created) { try { c.ws.close(); } catch { /* noop */ } }
  created.length = 0;
  clients.clear();
  calls.clear();
});

// ─── test client helper ──────────────────────────────────────────────────────
function makeClient() {
  const ws = new WebSocket(baseUrl);
  const queue = [];      // JSON messages not yet consumed
  const waiters = [];    // pending waitFor(type)
  const bins = [];       // binary (audio) frames
  const binWaiters = [];

  const onMessage = (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      const i = binWaiters.findIndex(w => w.type === 'binary');
      if (i >= 0) { const w = binWaiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(buf); return; }
      bins.push(buf);
      return;
    }
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : data.toString()); }
    catch { return; }
    const i = waiters.findIndex(w => w.type === m.t);
    if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m); return; }
    queue.push(m);
  };

  const client = {
    ws,
    get id() { return ws.id; },
    send(obj) { ws.send(JSON.stringify(obj)); },
    sendBin(buf) { ws.send(buf); },
    open() { return new Promise((resolve, reject) => {
      ws.on('open', () => resolve(client));
      ws.on('error', reject);
    }); },
    waitFor(type, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const idx = queue.findIndex(m => m.t === type);
        if (idx >= 0) { resolve(queue.splice(idx, 1)[0]); return; }
        const w = { type, resolve, timer: setTimeout(() => {
          const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timeout waiting for "${type}"`));
        }, timeout) };
        waiters.push(w);
      });
    },
    waitBin(timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (bins.length) { resolve(bins.shift()); return; }
        const w = { type: 'binary', resolve, timer: setTimeout(() => {
          const i = binWaiters.indexOf(w); if (i >= 0) binWaiters.splice(i, 1);
          reject(new Error('timeout waiting for binary frame'));
        }, timeout) };
        binWaiters.push(w);
      });
    },
    close() { ws.close(); },
  };
  ws.on('message', onMessage);
  created.push(client);
  return client;
}

// Register a client, answering the server's challenge/response with the
// client's Ed25519 key. `ident` may be supplied to reconnect as the same id.
async function connect(ident, token) {
  const c = makeClient();
  await c.open();
  const id = ident.id;
  c.ident = ident;
  c.send({ t: 'register', id, pubKey: ident.publicKeyB64, token });
  const ch = await c.waitFor('challenge');
  const nonceBytes = Buffer.from(ch.nonce, 'base64');
  const sig = await ident.sign(nonceBytes);
  c.send({ t: 'auth', id, sig });
  const reg = await c.waitFor('registered');
  expect(reg.id).toBe(id);
  return c;
}

async function expectNo(client, type, ms = 250) {
  try { await client.waitFor(type, ms); throw new Error(`expected NO "${type}" but got one`); }
  catch (e) { if (/expected NO/.test(e.message)) throw e; /* timeout = good */ }
}

// Register a client whose id is already taken; expect an id-taken rejection
// (no challenge is issued). Returns the id-taken message.
async function connectExpectIdTaken(ident) {
  const c = makeClient();
  await c.open();
  c.send({ t: 'register', id: ident.id, pubKey: (await generateIdentity()).publicKeyB64 });
  const taken = await c.waitFor('id-taken');
  expect(taken.id).toBe(ident.id);
  return taken;
}

// Build a signed key-exchange offer for a call (mimics what the app does).
async function makeOffer(ident, to, callId) {
  const { offer } = await CallSession.initiator(ident, to, callId);
  return offer;
}
async function makeAnswer(ident, from, callId, offer) {
  const { answer } = await CallSession.responder(ident, from, callId, offer);
  return answer;
}

// Establish an accepted call between two clients; returns { a, b, callId }.
async function establishCall(aId, bId, callId) {
  const a = await connect(aId);
  const b = await connect(bId);
  const offer = await makeOffer(a.ident, bId.id, callId);
  a.send({ t: 'call', to: bId.id, callId, offer });
  const inc = await b.waitFor('incoming');
  expect(inc.from).toBe(aId.id);
  expect(inc.callId).toBe(callId);
  const answer = await makeAnswer(b.ident, aId.id, callId, inc.offer);
  b.send({ t: 'accept', callId, to: aId.id, answer });
  const acc = await a.waitFor('accepted');
  expect(acc.callId).toBe(callId);
  expect(acc.answer).toEqual(answer);
  return { a, b, callId };
}

// ─── tests ───────────────────────────────────────────────────────────────────
describe('register', () => {
  it('registers two distinct clients', async () => {
    const a = await connect(await generateIdentity());
    const b = await connect(await generateIdentity());
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  it('rejects a key that does not match the claimed id (id-mismatch)', async () => {
    const ident = await generateIdentity();
    const c = makeClient();
    await c.open();
    // A valid key, but one whose fingerprint is NOT `ident.id`. The server must
    // reject this before any challenge is issued (you can only own an id if you
    // hold the matching private key).
    c.send({ t: 'register', id: ident.id, pubKey: (await generateIdentity()).publicKeyB64 });
    const denied = await c.waitFor('register-denied');
    expect(denied.reason).toBe('id-mismatch');
  });

  it('allows a second socket with the same key to take over the id', async () => {
    // The only way to see id-taken-style behaviour is a genuine reconnect: the
    // same id+key reconnects. The server evicts the stale socket and lets the
    // new one register, so the id stays "online" rather than being rejected.
    const ident = await generateIdentity();
    const first = await connect(ident);
    first.close();
    await new Promise((r) => setTimeout(r, 50));
    const second = await connect(ident);
    expect(second).toBeTruthy();
    expect(clients.get(ident.id)).toBeTruthy();
  });

  it('rejects an id that is not the fingerprint of the pubkey', async () => {
    const c = makeClient();
    await c.open();
    c.send({ t: 'register', id: 'not-a-fingerprint', pubKey: (await generateIdentity()).publicKeyB64 });
    const denied = await c.waitFor('register-denied');
    expect(denied.reason).toBe('id-mismatch');
  });

  it('rejects a bad auth signature', async () => {
    const ident = await generateIdentity();
    const c = makeClient();
    await c.open();
    c.send({ t: 'register', id: ident.id, pubKey: ident.publicKeyB64 });
    await c.waitFor('challenge');
    c.send({ t: 'auth', id: ident.id, sig: 'AAAA' });
    const denied = await c.waitFor('register-denied');
    expect(denied.reason).toBe('bad-signature');
  });

  it('allows a legitimate reconnect (same key, new socket)', async () => {
    const ident = await generateIdentity();
    const first = await connect(ident);
    first.close();
    await new Promise((r) => setTimeout(r, 20));
    const second = await connect(ident); // same id+key should succeed
    expect(second).toBeTruthy();
  });
});

describe('call signaling', () => {
  it('calls, delivers incoming, and accepts', async () => {
    const { a, b, callId } = await establishCall(await generateIdentity(), await generateIdentity(), 'call-1');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // caller's pending outgoing is cleared once accepted
    expect(clients.get(a.ident.id).pendingOutgoing).toBeNull();
    // both server sockets now carry the active call id
    expect(clients.get(a.ident.id).currentCall).toBe(callId);
    expect(clients.get(b.ident.id).currentCall).toBe(callId);
  });

  it('rejects an incoming call', async () => {
    const a = await connect(await generateIdentity());
    const b = await connect(await generateIdentity());
    const offer = await makeOffer(a.ident, b.ident.id, 'call-2');
    a.send({ t: 'call', to: b.ident.id, callId: 'call-2', offer });
    await b.waitFor('incoming');
    b.send({ t: 'reject', callId: 'call-2', to: a.ident.id });
    const rej = await a.waitFor('rejected');
    expect(rej.callId).toBe('call-2');
    // callee had no pending outgoing of its own
    expect(clients.get(b.ident.id).pendingOutgoing).toBeNull();
  });

  it('cancels an outgoing call', async () => {
    const a = await connect(await generateIdentity());
    const b = await connect(await generateIdentity());
    const offer = await makeOffer(a.ident, b.ident.id, 'call-3');
    a.send({ t: 'call', to: b.ident.id, callId: 'call-3', offer });
    await b.waitFor('incoming');
    a.send({ t: 'cancel', callId: 'call-3', to: b.ident.id });
    const canc = await b.waitFor('cancelled');
    expect(canc.callId).toBe('call-3');
  });

  it('reports busy when the target is already in a call', async () => {
    const { a, b } = await establishCall(await generateIdentity(), await generateIdentity(), 'call-4');
    const c = await connect(await generateIdentity());
    const offer = await makeOffer(c.ident, a.ident.id, 'call-4c');
    c.send({ t: 'call', to: a.ident.id, callId: 'call-4c', offer });
    const busy = await c.waitFor('busy');
    expect(busy.callId).toBe('call-4c');
    void a; void b;
  });

  it('reports peer-unavailable for an unknown target', async () => {
    const a = await connect(await generateIdentity());
    const offer = await makeOffer(a.ident, 'ghost', 'call-5');
    a.send({ t: 'call', to: 'ghost', callId: 'call-5', offer });
    const una = await a.waitFor('peer-unavailable');
    expect(una.callId).toBe('call-5');
  });

  it('ignores a call to self', async () => {
    const a = await connect(await generateIdentity());
    const offer = await makeOffer(a.ident, a.ident.id, 'call-6');
    a.send({ t: 'call', to: a.ident.id, callId: 'call-6', offer });
    await expectNo(a, 'incoming');
  });

  it('forwards the caller id in incoming (no display name)', async () => {
    const a = await connect(await generateIdentity());
    const b = await connect(await generateIdentity());
    const offer = await makeOffer(a.ident, b.ident.id, 'call-name');
    a.send({ t: 'call', to: b.ident.id, callId: 'call-name', offer });
    const inc = await b.waitFor('incoming');
    expect(inc.from).toBe(a.ident.id);
    expect(inc.offer).toEqual(offer);
  });

  it('clears caller pendingOutgoing when the caller rejects', async () => {
    const a = await connect(await generateIdentity());
    const b = await connect(await generateIdentity());
    const offer = await makeOffer(a.ident, b.ident.id, 'call-r');
    a.send({ t: 'call', to: b.ident.id, callId: 'call-r', offer });
    await b.waitFor('incoming');
    a.send({ t: 'reject', callId: 'call-r', to: b.ident.id });
    const rej = await b.waitFor('rejected');
    expect(rej.callId).toBe('call-r');
    expect(clients.get(a.ident.id).pendingOutgoing).toBeNull();
  });

  it('ends a call via hangup', async () => {
    const { a, b, callId } = await establishCall(await generateIdentity(), await generateIdentity(), 'call-7');
    a.send({ t: 'hangup', callId, to: b.ident.id });
    const ended = await b.waitFor('ended');
    expect(ended.callId).toBe(callId);
    expect(calls.has(callId)).toBe(false);
    expect(clients.get(a.ident.id).currentCall).toBeNull();
    expect(clients.get(b.ident.id).currentCall).toBeNull();
  });

  it('forwards mute state to the peer', async () => {
    const { a, b } = await establishCall(await generateIdentity(), await generateIdentity(), 'call-8');
    a.send({ t: 'mute', to: b.ident.id, muted: true });
    const muted = await b.waitFor('muted');
    expect(muted.from).toBe(a.ident.id);
    expect(muted.muted).toBe(true);
  });

  it('answers ping with pong', async () => {
    const a = await connect(await generateIdentity());
    a.send({ t: 'ping' });
    const pong = await a.waitFor('pong');
    expect(pong.t).toBe('pong');
  });
});

describe('audio forwarding', () => {
  it('forwards a binary frame from caller to callee', async () => {
    const { a, b } = await establishCall(await generateIdentity(), await generateIdentity(), 'call-10');
    const frame = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    a.sendBin(frame);
    const got = await b.waitBin();
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(frame)).toBe(true);
  });

  it('does not forward audio when no call is active', async () => {
    const a = await connect(await generateIdentity());
    const b = await connect(await generateIdentity());
    a.sendBin(Buffer.from([9, 9, 9]));
    await expect(b.waitBin(200)).rejects.toThrow();
  });
});

describe('reconnect', () => {
  it('notifies the peer on drop and re-establishes on reconnect', async () => {
    const idA = await generateIdentity();
    const { a, b, callId } = await establishCall(idA, await generateIdentity(), 'call-12');
    // Peer drops.
    a.close();
    const rec = await b.waitFor('reconnecting');
    expect(rec.callId).toBe(callId);

    // Peer reconnects with the same identity (same key) and resumes the call.
    await new Promise((r) => setTimeout(r, 50));
    const a2 = await connect(idA);
    a2.send({ t: 'reconnect', callId, to: b.ident.id });
    const recA = await a2.waitFor('reconnected');
    const recB = await b.waitFor('reconnected');
    expect(recA.callId).toBe(callId);
    expect(recB.callId).toBe(callId);

    // Audio flows again.
    const frame = Buffer.from([0xaa, 0xbb, 0xcc]);
    a2.sendBin(frame);
    const got = await b.waitBin();
    expect(got.equals(frame)).toBe(true);
  });

  it('still allows a reconnect within the drop grace window', async () => {
    const idA = await generateIdentity();
    const { a, b, callId } = await establishCall(idA, await generateIdentity(), 'call-13');
    a.close();
    await b.waitFor('reconnecting');
    // Within the grace window the call is still held open by the server.
    await new Promise((r) => setTimeout(r, 50));
    const a2 = await connect(idA);
    a2.send({ t: 'reconnect', callId, to: b.ident.id });
    const recA = await a2.waitFor('reconnected');
    const recB = await b.waitFor('reconnected');
    expect(recA.callId).toBe(callId);
    expect(recB.callId).toBe(callId);
    // Audio flows again after the in-window reconnect.
    const frame = Buffer.from([0xaa, 0xbb, 0xcc]);
    a2.sendBin(frame);
    const got = await b.waitBin();
    expect(got.equals(frame)).toBe(true);
  });
});

// ─── HTTP health-check / static surface ───────────────────────────────────────
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

describe('http server', () => {
  it('responds 200 ok on /healthz', async () => {
    const r = await httpGet('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toBe('ok');
  });
  it('responds 200 ok on /', async () => {
    const r = await httpGet('/');
    expect(r.status).toBe(200);
    expect(r.body).toBe('ok');
  });
  it('responds 404 on unknown paths', async () => {
    const r = await httpGet('/does-not-exist');
    expect(r.status).toBe(404);
  });
});

// ─── multiple / misc signaling ────────────────────────────────────────────────
describe('signaling edge cases', () => {
  it('hangs up from the callee side too', async () => {
    const { a, b, callId } = await establishCall(await generateIdentity(), await generateIdentity(), 'call-14');
    b.send({ t: 'hangup', callId, to: a.ident.id });
    const ended = await a.waitFor('ended');
    expect(ended.callId).toBe(callId);
    expect(calls.has(callId)).toBe(false);
  });

  it('keeps two independent calls isolated', async () => {
    const c1 = await establishCall(await generateIdentity(), await generateIdentity(), 'call-15');
    const c2 = await establishCall(await generateIdentity(), await generateIdentity(), 'call-16');
    expect(calls.size).toBe(2);
    // A frame from call 1 must not reach call 2's callee.
    const frame = Buffer.from([1, 2, 3]);
    c1.a.sendBin(frame);
    const got = await c1.b.waitBin();
    expect(got.equals(frame)).toBe(true);
    await expect(c2.b.waitBin(200)).rejects.toThrow();
    void c2;
  });

  it('forwards many audio frames in order', async () => {
    const { a, b } = await establishCall(await generateIdentity(), await generateIdentity(), 'call-17');
    for (let i = 0; i < 5; i++) {
      const f = Buffer.from([i, i + 1, i + 2]);
      a.sendBin(f);
      const got = await b.waitBin();
      expect(got.equals(f)).toBe(true);
    }
  });

  it('allows a third client to call a free peer after a call ends', async () => {
    const { a, b, callId } = await establishCall(await generateIdentity(), await generateIdentity(), 'call-18');
    a.send({ t: 'hangup', callId, to: b.ident.id });
    await b.waitFor('ended');
    const c = await connect(await generateIdentity());
    const offer = await makeOffer(c.ident, b.ident.id, 'call-18c');
    c.send({ t: 'call', to: b.ident.id, callId: 'call-18c', offer });
    const inc = await b.waitFor('incoming');
    expect(inc.from).toBe(c.ident.id);
  });

  it('ignores malformed (non-JSON) messages without crashing', async () => {
    const ident = await generateIdentity();
    const a = await connect(ident);
    a.ws.send('this is not json');
    // server should silently drop it; a valid reconnect with the same key still works
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    const a2 = await connect(ident);
    expect(a2).toBeTruthy();
  });
});
