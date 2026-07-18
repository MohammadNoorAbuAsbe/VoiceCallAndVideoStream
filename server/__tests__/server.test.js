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

async function connect(id, token) {
  const c = makeClient();
  await c.open();
  c.send({ t: 'register', id, token });
  const reg = await c.waitFor('registered');
  expect(reg.id).toBe(id);
  return c;
}

async function expectNo(client, type, ms = 250) {
  try { await client.waitFor(type, ms); throw new Error(`expected NO "${type}" but got one`); }
  catch (e) { if (/expected NO/.test(e.message)) throw e; /* timeout = good */ }
}

// Establish an accepted call between two clients; returns { a, b, callId }.
async function establishCall(aId, bId, callId) {
  const a = await connect(aId);
  const b = await connect(bId);
  a.send({ t: 'call', to: bId, name: aId, callId });
  const inc = await b.waitFor('incoming');
  expect(inc.from).toBe(aId);
  expect(inc.callId).toBe(callId);
  b.send({ t: 'accept', callId, to: aId });
  const acc = await a.waitFor('accepted');
  expect(acc.callId).toBe(callId);
  return { a, b, callId };
}

// ─── tests ───────────────────────────────────────────────────────────────────
describe('register', () => {
  it('registers two distinct clients', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
  });

  it('rejects a duplicate id with id-taken', async () => {
    await connect('dup');
    const c = makeClient();
    await c.open();
    c.send({ t: 'register', id: 'dup' });
    const taken = await c.waitFor('id-taken');
    expect(taken.id).toBe('dup');
  });

  it('rejects an empty/whitespace id with id-taken', async () => {
    const c = makeClient();
    await c.open();
    c.send({ t: 'register', id: '   ' });
    const taken = await c.waitFor('id-taken');
    expect(taken.id).toBe(''); // server trims before checking
  });
});

describe('call signaling', () => {
  it('calls, delivers incoming, and accepts', async () => {
    const { a, b, callId } = await establishCall('a1', 'b1', 'call-1');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // caller's pending outgoing is cleared once accepted
    expect(clients.get('a1').pendingOutgoing).toBeNull();
    // both server sockets now carry the active call id
    expect(clients.get('a1').currentCall).toBe(callId);
    expect(clients.get('b1').currentCall).toBe(callId);
    void callId;
  });

  it('rejects an incoming call', async () => {
    const a = await connect('a2');
    const b = await connect('b2');
    a.send({ t: 'call', to: 'b2', name: 'a2', callId: 'call-2' });
    await b.waitFor('incoming');
    b.send({ t: 'reject', callId: 'call-2', to: 'a2' });
    const rej = await a.waitFor('rejected');
    expect(rej.callId).toBe('call-2');
    // callee had no pending outgoing of its own
    expect(clients.get('b2').pendingOutgoing).toBeNull();
  });

  it('cancels an outgoing call', async () => {
    const a = await connect('a3');
    const b = await connect('b3');
    a.send({ t: 'call', to: 'b3', name: 'a3', callId: 'call-3' });
    await b.waitFor('incoming');
    a.send({ t: 'cancel', callId: 'call-3', to: 'b3' });
    const canc = await b.waitFor('cancelled');
    expect(canc.callId).toBe('call-3');
  });

  it('reports busy when the target is already in a call', async () => {
    const { a, b } = await establishCall('a4', 'b4', 'call-4');
    const c = await connect('c4');
    c.send({ t: 'call', to: 'a4', name: 'c4', callId: 'call-4c' });
    const busy = await c.waitFor('busy');
    expect(busy.callId).toBe('call-4c');
    void a; void b;
  });

  it('reports peer-unavailable for an unknown target', async () => {
    const a = await connect('a5');
    a.send({ t: 'call', to: 'ghost', name: 'a5', callId: 'call-5' });
    const una = await a.waitFor('peer-unavailable');
    expect(una.callId).toBe('call-5');
  });

  it('ignores a call to self', async () => {
    const a = await connect('a6');
    a.send({ t: 'call', to: 'a6', name: 'a6', callId: 'call-6' });
    await expectNo(a, 'incoming');
  });

  it('falls back to the caller id when no display name is given', async () => {
    const a = await connect('a-name');
    const b = await connect('b-name');
    a.send({ t: 'call', to: 'b-name', callId: 'call-name' }); // no name field
    const inc = await b.waitFor('incoming');
    expect(inc.name).toBe('a-name'); // server substitutes ws.id
  });

  it('clears caller pendingOutgoing when the caller rejects', async () => {
    const a = await connect('a-r');
    const b = await connect('b-r');
    a.send({ t: 'call', to: 'b-r', name: 'a-r', callId: 'call-r' });
    await b.waitFor('incoming');
    a.send({ t: 'reject', callId: 'call-r', to: 'b-r' });
    const rej = await b.waitFor('rejected');
    expect(rej.callId).toBe('call-r');
    expect(clients.get('a-r').pendingOutgoing).toBeNull();
  });

  it('ends a call via hangup', async () => {
    const { a, b, callId } = await establishCall('a7', 'b7', 'call-7');
    a.send({ t: 'hangup', callId, to: 'b7' });
    const ended = await b.waitFor('ended');
    expect(ended.callId).toBe(callId);
    expect(calls.has(callId)).toBe(false);
    expect(clients.get('a7').currentCall).toBeNull();
    expect(clients.get('b7').currentCall).toBeNull();
  });

  it('forwards mute state to the peer', async () => {
    const { a, b } = await establishCall('a8', 'b8', 'call-8');
    a.send({ t: 'mute', to: 'b8', muted: true });
    const muted = await b.waitFor('muted');
    expect(muted.from).toBe('a8');
    expect(muted.muted).toBe(true);
  });

  it('answers ping with pong', async () => {
    const a = await connect('a9');
    a.send({ t: 'ping' });
    const pong = await a.waitFor('pong');
    expect(pong.t).toBe('pong');
  });
});

describe('audio forwarding', () => {
  it('forwards a binary frame from caller to callee', async () => {
    const { a, b } = await establishCall('a10', 'b10', 'call-10');
    const frame = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    a.sendBin(frame);
    const got = await b.waitBin();
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(frame)).toBe(true);
  });

  it('does not forward audio when no call is active', async () => {
    const a = await connect('a11');
    const b = await connect('b11');
    a.sendBin(Buffer.from([9, 9, 9]));
    await expect(b.waitBin(200)).rejects.toThrow();
  });
});

describe('reconnect', () => {
  it('notifies the peer on drop and re-establishes on reconnect', async () => {
    const { a, b, callId } = await establishCall('a12', 'b12', 'call-12');
    // Peer drops.
    a.close();
    const rec = await b.waitFor('reconnecting');
    expect(rec.callId).toBe(callId);

    // Peer reconnects as the same id and resumes the call.
    const a2 = await connect('a12');
    a2.send({ t: 'reconnect', callId, to: 'b12' });
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
    const { a, b, callId } = await establishCall('a13', 'b13', 'call-13');
    a.close();
    await b.waitFor('reconnecting');
    // Within the grace window the call is still held open by the server.
    const a2 = makeClient();
    await a2.open();
    a2.send({ t: 'register', id: 'a13' });
    await a2.waitFor('registered');
    a2.send({ t: 'reconnect', callId, to: 'b13' });
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
    const { a, b, callId } = await establishCall('a14', 'b14', 'call-14');
    b.send({ t: 'hangup', callId, to: 'a14' });
    const ended = await a.waitFor('ended');
    expect(ended.callId).toBe(callId);
    expect(calls.has(callId)).toBe(false);
  });

  it('keeps two independent calls isolated', async () => {
    const c1 = await establishCall('a15', 'b15', 'call-15');
    const c2 = await establishCall('a16', 'b16', 'call-16');
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
    const { a, b } = await establishCall('a17', 'b17', 'call-17');
    for (let i = 0; i < 5; i++) {
      const f = Buffer.from([i, i + 1, i + 2]);
      a.sendBin(f);
      const got = await b.waitBin();
      expect(got.equals(f)).toBe(true);
    }
  });

  it('allows a third client to call a free peer after a call ends', async () => {
    const { a, b, callId } = await establishCall('a18', 'b18', 'call-18');
    a.send({ t: 'hangup', callId, to: 'b18' });
    await b.waitFor('ended');
    const c = await connect('c18');
    c.send({ t: 'call', to: 'b18', name: 'c18', callId: 'call-18c' });
    const inc = await b.waitFor('incoming');
    expect(inc.from).toBe('c18');
  });

  it('ignores malformed (non-JSON) messages without crashing', async () => {
    const a = await connect('a-bad');
    a.ws.send('this is not json');
    // server should silently drop it; a subsequent valid message still works
    a.send({ t: 'register', id: 'a-bad' });
    const taken = await a.waitFor('id-taken');
    expect(taken.id).toBe('a-bad');
  });
});
