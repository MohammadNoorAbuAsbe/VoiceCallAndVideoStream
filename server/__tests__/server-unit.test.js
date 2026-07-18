// ─────────────────────────────────────────────────────────────────────────────
//  Relay server — unit tests for the protocol functions (handleMessage /
//  handleAudio / handleClose / attachRelay) driven with fake WebSocket objects,
//  no real network and no real timers.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  handleMessage, handleAudio, handleClose, attachRelay, clients, calls, fingerprint,
} from '../server.js';
import { generateIdentity } from '../../src/crypto.js';

// Drive the full register → challenge → auth handshake for a real identity,
// returning the final response message ({ t: 'registered' | ... }).
async function register(ws, ident) {
  await handleMessage(ws, { t: 'register', id: ident.id, pubKey: ident.publicKeyB64 });
  const ch = ws.emits('challenge');
  const sig = await ident.sign(Buffer.from(ch.nonce, 'base64'));
  await handleMessage(ws, { t: 'auth', id: ident.id, sig });
  return ws.last;
}

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1; // OPEN
    this.sent = [];
    this.id = null;
    this.currentCall = null;
    this.pendingOutgoing = null;
    this.isAlive = true;
  }
  send(d) { this.sent.push(typeof d === 'string' ? JSON.parse(d) : d); }
  close() {}
  terminate() {}
  get last() { return this.sent[this.sent.length - 1]; }
  emits(type) { return this.sent.find((m) => m.t === type); }
}

beforeEach(() => { clients.clear(); calls.clear(); });
afterEach(() => { clients.clear(); calls.clear(); });

describe('handleMessage: register', () => {
  it('registers a valid id and records the socket', async () => {
    const ws = new FakeWs();
    const ident = await generateIdentity();
    const res = await register(ws, ident);
    expect(res).toEqual({ t: 'registered', id: ident.id });
    expect(ws.id).toBe(ident.id);
    expect(clients.get(ident.id)).toBe(ws);
  });
  it('rejects an id whose key is not its fingerprint', async () => {
    const ws = new FakeWs();
    const ident = await generateIdentity();
    await handleMessage(ws, { t: 'register', id: 'not-the-fingerprint', pubKey: ident.publicKeyB64 });
    expect(ws.last).toEqual({ t: 'register-denied', reason: 'id-mismatch' });
    expect(ws.id).toBeNull();
  });
  it('rejects a second registration of an already-online id with id-taken', async () => {
    const a = await generateIdentity();
    const aw = new FakeWs();
    await register(aw, a);
    // Same identity (same key) connecting from a second socket — the id is still
    // the fingerprint of the pubkey, so it's not an id-mismatch, but the id is
    // already online.
    const aw2 = new FakeWs();
    await handleMessage(aw2, { t: 'register', id: a.id, pubKey: a.publicKeyB64 });
    expect(aw2.last).toEqual({ t: 'id-taken', id: a.id });
  });
  it('allows registration with a token when no token is required', async () => {
    const ws = new FakeWs();
    const ident = await generateIdentity();
    const res = await register(ws, ident);
    expect(res).toEqual({ t: 'registered', id: ident.id });
  });
});

describe('handleMessage: call', () => {
  it('ignores a call from an unregistered socket', () => {
    const ws = new FakeWs(); // id null
    handleMessage(ws, { t: 'call', to: 'bob', name: 'x', callId: 'c1' });
    expect(ws.sent.length).toBe(0);
  });
  it('ignores a call to self', () => {
    const ws = new FakeWs();
    ws.id = 'me';
    handleMessage(ws, { t: 'call', to: 'me', name: 'me', callId: 'c1' });
    expect(ws.sent.length).toBe(0);
  });
  it('reports peer-unavailable for an unknown target', () => {
    const ws = new FakeWs();
    ws.id = 'me';
    handleMessage(ws, { t: 'call', to: 'ghost', name: 'me', callId: 'c1' });
    expect(ws.emits('peer-unavailable')).toEqual({ t: 'peer-unavailable', callId: 'c1' });
  });
  it('reports busy when the target is already in a call', () => {
    const a = new FakeWs(); a.id = 'a';
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    b.currentCall = 'other-call';
    handleMessage(a, { t: 'call', to: 'b', name: 'a', callId: 'c1' });
    expect(a.emits('busy')).toEqual({ t: 'busy', callId: 'c1' });
  });
  it('delivers incoming and sets pendingOutgoing on success', () => {
    const a = new FakeWs(); a.id = 'a';
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    const offer = { idPub: 'P', ephPub: 'E', sig: 'S' };
    handleMessage(a, { t: 'call', to: 'b', callId: 'c1', offer });
    expect(a.pendingOutgoing).toEqual({ to: 'b', callId: 'c1' });
    expect(b.emits('incoming')).toEqual({ t: 'incoming', from: 'a', callId: 'c1', offer });
  });
});

describe('handleMessage: accept', () => {
  it('reports peer-unavailable when the caller is missing', () => {
    const ws = new FakeWs(); ws.id = 'b';
    clients.set('b', ws);
    handleMessage(ws, { t: 'accept', callId: 'c1', to: 'ghost' });
    expect(ws.emits('peer-unavailable')).toEqual({ t: 'peer-unavailable', callId: 'c1' });
  });
  it('establishes the call on both sides', () => {
    const a = new FakeWs(); a.id = 'a'; a.pendingOutgoing = { to: 'b', callId: 'c1' };
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    const answer = { idPub: 'P', ephPub: 'E', sig: 'S' };
    handleMessage(b, { t: 'accept', callId: 'c1', to: 'a', answer });
    expect(a.emits('accepted')).toEqual({ t: 'accepted', callId: 'c1', from: 'b', answer });
    expect(a.currentCall).toBe('c1');
    expect(b.currentCall).toBe('c1');
    expect(a.pendingOutgoing).toBeNull();
    expect(calls.get('c1').accepted).toBe(true);
  });
});

describe('handleMessage: reject / cancel', () => {
  it('notifies the caller on reject (reject clears the callee pending, not the caller)', () => {
    const a = new FakeWs(); a.id = 'a'; a.pendingOutgoing = { to: 'b', callId: 'c1' };
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    handleMessage(b, { t: 'reject', callId: 'c1', to: 'a' });
    // The server only clears the *receiving* socket's pendingOutgoing; the
    // caller's stale pending is cleared by the client on its 'rejected' event.
    expect(a.emits('rejected')).toEqual({ t: 'rejected', callId: 'c1' });
    expect(a.pendingOutgoing).toEqual({ to: 'b', callId: 'c1' });
  });
  it('reject with no pendingOutgoing still notifies caller if present', () => {
    const a = new FakeWs(); a.id = 'a';
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    handleMessage(b, { t: 'reject', callId: 'c1', to: 'a' });
    expect(a.emits('rejected')).toEqual({ t: 'rejected', callId: 'c1' });
  });
  it('clears pendingOutgoing and notifies callee on cancel', () => {
    const a = new FakeWs(); a.id = 'a'; a.pendingOutgoing = { to: 'b', callId: 'c1' };
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    handleMessage(a, { t: 'cancel', callId: 'c1', to: 'b' });
    expect(a.pendingOutgoing).toBeNull();
    expect(b.emits('cancelled')).toEqual({ t: 'cancelled', callId: 'c1' });
  });
  it('cancel with no pendingOutgoing still notifies callee if present', () => {
    const a = new FakeWs(); a.id = 'a';
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    handleMessage(a, { t: 'cancel', callId: 'c1', to: 'b' });
    expect(b.emits('cancelled')).toEqual({ t: 'cancelled', callId: 'c1' });
  });
});

describe('handleMessage: hangup', () => {
  it('ends the call for both peers and clears state', () => {
    const a = new FakeWs(); a.id = 'a'; a.currentCall = 'c1';
    const b = new FakeWs(); b.id = 'b'; b.currentCall = 'c1';
    clients.set('a', a); clients.set('b', b);
    calls.set('c1', { a: 'a', b: 'b' });
    handleMessage(a, { t: 'hangup', callId: 'c1', to: 'b' });
    expect(calls.has('c1')).toBe(false);
    expect(a.currentCall).toBeNull();
    expect(b.currentCall).toBeNull();
    expect(a.emits('ended')).toEqual({ t: 'ended', callId: 'c1' });
    expect(b.emits('ended')).toEqual({ t: 'ended', callId: 'c1' });
  });
  it('is a no-op for an unknown callId', () => {
    const a = new FakeWs(); a.id = 'a';
    clients.set('a', a);
    expect(() => handleMessage(a, { t: 'hangup', callId: 'nope', to: 'b' })).not.toThrow();
  });
});

describe('handleMessage: reconnect', () => {
  it('reports peer-unavailable when call or peer is missing', () => {
    const ws = new FakeWs(); ws.id = 'a';
    clients.set('a', ws);
    handleMessage(ws, { t: 'reconnect', callId: 'ghost', to: 'b' });
    expect(ws.emits('peer-unavailable')).toEqual({ t: 'peer-unavailable', callId: 'ghost' });
  });
  it('re-establishes the call and clears the drop timer', () => {
    const a = new FakeWs(); a.id = 'a';
    const b = new FakeWs(); b.id = 'b'; b.currentCall = 'c1';
    clients.set('a', a); clients.set('b', b);
    calls.set('c1', { a: 'a', b: 'b', dropTimer: 'TIMER' });
    handleMessage(a, { t: 'reconnect', callId: 'c1', to: 'b' });
    expect(a.currentCall).toBe('c1');
    expect(b.currentCall).toBe('c1');
    expect(calls.get('c1').dropTimer).toBeNull();
    expect(a.emits('reconnected')).toEqual({ t: 'reconnected', callId: 'c1' });
    expect(b.emits('reconnected')).toEqual({ t: 'reconnected', callId: 'c1' });
  });
});

describe('handleMessage: mute', () => {
  it('forwards mute to the peer', () => {
    const a = new FakeWs(); a.id = 'a';
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    handleMessage(a, { t: 'mute', to: 'b', muted: true });
    expect(b.emits('muted')).toEqual({ t: 'muted', from: 'a', muted: true });
  });
  it('is a silent no-op when the peer is missing', () => {
    const a = new FakeWs(); a.id = 'a';
    clients.set('a', a);
    expect(() => handleMessage(a, { t: 'mute', to: 'ghost', muted: true })).not.toThrow();
  });
});

describe('handleMessage: ping / default', () => {
  it('answers ping with pong', () => {
    const ws = new FakeWs();
    handleMessage(ws, { t: 'ping' });
    expect(ws.last).toEqual({ t: 'pong' });
  });
  it('ignores unknown message types', () => {
    const ws = new FakeWs();
    handleMessage(ws, { t: 'some-future-type' });
    expect(ws.sent.length).toBe(0);
  });
});

describe('handleAudio', () => {
  it('forwards a frame to the peer in the active call', () => {
    const a = new FakeWs(); a.id = 'a'; a.currentCall = 'c1';
    const b = new FakeWs(); b.id = 'b';
    clients.set('a', a); clients.set('b', b);
    calls.set('c1', { a: 'a', b: 'b' });
    const frame = Buffer.from([1, 2, 3]);
    handleAudio(a, frame);
    expect(b.last).toBe(frame);
  });
  it('does nothing when there is no active call', () => {
    const a = new FakeWs(); a.id = 'a';
    clients.set('a', a);
    expect(() => handleAudio(a, Buffer.from([1]))).not.toThrow();
  });
  it('does nothing when the call entry is missing', () => {
    const a = new FakeWs(); a.id = 'a'; a.currentCall = 'gone';
    clients.set('a', a);
    expect(() => handleAudio(a, Buffer.from([1]))).not.toThrow();
  });
  it('does nothing when the peer socket is missing', () => {
    const a = new FakeWs(); a.id = 'a'; a.currentCall = 'c1';
    clients.set('a', a);
    calls.set('c1', { a: 'a', b: 'ghost' });
    expect(() => handleAudio(a, Buffer.from([1]))).not.toThrow();
  });
});

describe('handleClose', () => {
  it('returns early when the socket was never registered', () => {
    const ws = new FakeWs();
    expect(() => handleClose(ws)).not.toThrow();
    expect(clients.size).toBe(0);
  });
  it('removes a registered, idle socket', () => {
    const ws = new FakeWs(); ws.id = 'a';
    clients.set('a', ws);
    handleClose(ws);
    expect(clients.has('a')).toBe(false);
  });
  it('notifies the peer and arms a drop timer on disconnect mid-call', () => {
    const a = new FakeWs(); a.id = 'a'; a.currentCall = 'c1';
    const b = new FakeWs(); b.id = 'b'; b.currentCall = 'c1';
    clients.set('a', a); clients.set('b', b);
    calls.set('c1', { a: 'a', b: 'b' });
    handleClose(a);
    expect(b.emits('reconnecting')).toEqual({ t: 'reconnecting', callId: 'c1' });
    expect(calls.get('c1').dropTimer).not.toBeNull();
  });
  it('tears down the call after the drop grace window expires', () => {
    vi.useFakeTimers();
    const a = new FakeWs(); a.id = 'a'; a.currentCall = 'c1';
    const b = new FakeWs(); b.id = 'b'; b.currentCall = 'c1';
    clients.set('a', a); clients.set('b', b);
    calls.set('c1', { a: 'a', b: 'b' });
    handleClose(a);
    vi.advanceTimersByTime(30000);
    expect(calls.has('c1')).toBe(false);
    expect(b.currentCall).toBeNull();
    expect(b.emits('ended')).toEqual({ t: 'ended', callId: 'c1' });
    vi.useRealTimers();
  });
  it('is a no-op when the dropped socket has no current call', () => {
    const a = new FakeWs(); a.id = 'a'; a.currentCall = null;
    clients.set('a', a);
    expect(() => handleClose(a)).not.toThrow();
  });
  it('is a no-op when the call entry is already gone', () => {
    const a = new FakeWs(); a.id = 'a'; a.currentCall = 'gone';
    clients.set('a', a);
    expect(() => handleClose(a)).not.toThrow();
  });
});

describe('attachRelay', () => {
  it('wires connection handlers and routes messages', () => {
    const fakeServer = new EventEmitter();
    attachRelay(fakeServer);
    const ws = new FakeWs();
    fakeServer.emit('connection', ws);
    // ping -> pong
    ws.emit('message', JSON.stringify({ t: 'ping' }), false);
    expect(ws.emits('pong')).toEqual({ t: 'pong' });
    // pong resets isAlive
    ws.isAlive = false;
    ws.emit('pong');
    expect(ws.isAlive).toBe(true);
    // binary audio is handled without throwing (no active call)
    expect(() => ws.emit('message', Buffer.from([1, 2]), true)).not.toThrow();
    // error handler is a no-op
    expect(() => ws.emit('error', new Error('x'))).not.toThrow();
    // close handler runs
    expect(() => ws.emit('close')).not.toThrow();
  });
});
