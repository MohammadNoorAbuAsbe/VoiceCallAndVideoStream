// @vitest-environment jsdom
// Tests for the RelayClient signaling layer using a mock WebSocket (no network).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RelayClient } from '../relay.js';

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static throwOnConstruct = false;
  constructor(url) {
    if (MockWebSocket.throwOnConstruct) throw new Error('boom');
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.binaryType = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }
  send(data) {
    if (typeof data === 'string') this.sent.push(JSON.parse(data));
    else this.sent.push({ _binary: true, data });
  }
  triggerOpen() { this.readyState = MockWebSocket.OPEN; this.onopen && this.onopen(); }
  triggerMessage(data) { this.onmessage && this.onmessage({ data }); }
  triggerClose() { this.readyState = MockWebSocket.CLOSED; this.onclose && this.onclose(); }
  close() { this.readyState = MockWebSocket.CLOSED; }
}
MockWebSocket.instances = [];

beforeEach(() => {
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket;
});

const lastSent = (ws) => ws.sent[ws.sent.length - 1];
const firstWs = () => MockWebSocket.instances[0];

describe('event subscription', () => {
  it('registers listeners and emits to them (chainable)', () => {
    const rc = new RelayClient('wss://r');
    const seen = [];
    const ret = rc.on('registered', (m) => seen.push(m));
    expect(ret).toBe(rc);
    rc._emit('registered', { id: 'x' });
    expect(seen).toEqual([{ id: 'x' }]);
  });

  it('supports multiple listeners for one type', () => {
    const rc = new RelayClient('wss://r');
    const a = [], b = [];
    rc.on('busy', (m) => a.push(m)).on('busy', (m) => b.push(m));
    rc._emit('busy', { callId: 'c' });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });
});

describe('connect', () => {
  it('opens a socket and sends a register message', () => {
    const rc = new RelayClient('wss://r');
    rc.connect('me', 'tok');
    const ws = firstWs();
    expect(ws.url).toBe('wss://r');
    ws.triggerOpen();
    expect(rc.connected).toBe(true);
    expect(lastSent(ws)).toEqual({ t: 'register', id: 'me', token: 'tok' });
  });

  it('schedules a reconnect after an unexpected close', () => {
    vi.useFakeTimers();
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    expect(MockWebSocket.instances.length).toBe(1);
    ws.triggerClose();
    expect(rc.connected).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances.length).toBe(2); // a new socket was opened
    clearInterval(rc.heartbeat);
    clearTimeout(rc.reconnectTimer);
    vi.useRealTimers();
  });

  it('does NOT schedule a reconnect when the socket closed before any id', () => {
    vi.useFakeTimers();
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    rc.id = null; // simulate losing the id (e.g. never registered)
    const before = MockWebSocket.instances.length;
    ws.triggerClose();
    expect(rc.connected).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances.length).toBe(before); // no new socket
    clearInterval(rc.heartbeat);
    clearTimeout(rc.reconnectTimer);
    vi.useRealTimers();
  });

  it('schedules a reconnect when the WebSocket constructor throws', () => {
    vi.useFakeTimers();
    MockWebSocket.throwOnConstruct = true;
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    expect(MockWebSocket.instances.length).toBe(0); // constructor threw
    expect(rc.reconnectTimer).not.toBeNull();
    clearTimeout(rc.reconnectTimer);
    MockWebSocket.throwOnConstruct = false;
    vi.useRealTimers();
  });

  it('updates connected across the open/close lifecycle', () => {
    const rc = new RelayClient('wss://r');
    expect(rc.connected).toBe(false);
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    expect(rc.connected).toBe(true);
    ws.triggerClose();
    expect(rc.connected).toBe(false);
    clearTimeout(rc.reconnectTimer);
  });
});

describe('command methods when not yet open', () => {
  it('does not throw when called before the socket opens', () => {
    const rc = new RelayClient('wss://r');
    rc.connect('me'); // ws exists but still CONNECTING
    expect(() => {
      rc.call('b', 'me', 'c');
      rc.accept('c', 'b');
      rc.reject('c', 'b');
      rc.cancel('c', 'b');
      rc.hangup('c', 'b');
      rc.reconnect('c', 'b');
      rc.sendMute('b', true);
      rc.sendAudio(new Uint8Array([1]));
    }).not.toThrow();
  });
});

describe('send safety', () => {
  it('sendAudio is a no-op when the socket is not open', () => {
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);
    rc.sendAudio(new Uint8Array([1, 2, 3]));
    expect(ws.sent.length).toBe(0);
  });

  it('_send is a no-op when there is no socket', () => {
    const rc = new RelayClient('wss://r');
    // rc.ws is still null (no connect)
    expect(() => rc.call('b', 'me', 'c')).not.toThrow();
  });
});

describe('heartbeat', () => {
  it('starts a ping interval on open and clears it on close', () => {
    vi.useFakeTimers();
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    expect(rc.heartbeat).not.toBeNull();
    vi.advanceTimersByTime(20000);
    expect(lastSent(ws)).toEqual({ t: 'ping' });
    ws.triggerClose();
    expect(rc.heartbeat).toBeNull();
    clearTimeout(rc.reconnectTimer);
    vi.useRealTimers();
  });
});

describe('incoming message safety', () => {
  it('ignores invalid JSON without emitting', () => {
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    let fired = false;
    rc.on('weird', () => { fired = true; });
    ws.triggerMessage('this is not json{');
    expect(fired).toBe(false);
  });

  it('ignores a binary message that is not a Uint8Array', () => {
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    const frames = [];
    rc.on('audio', (u) => frames.push(u));
    ws.onmessage({ data: 'a string' }); // typeof string → JSON path
    expect(frames.length).toBe(0);
  });

  it('connect with no token sends token:null', () => {
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    expect(lastSent(ws)).toEqual({ t: 'register', id: 'me', token: null });
  });

  it('onerror handler exists and is callable', () => {
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    expect(() => ws.onerror && ws.onerror(new Error('x'))).not.toThrow();
  });
});

describe('command methods', () => {
  function connected() {
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    return { rc, ws };
  }

  it('call sends to/from/callId', () => {
    const { ws, rc } = connected();
    rc.call('bob', 'me', 'c1');
    expect(lastSent(ws)).toEqual({ t: 'call', to: 'bob', name: 'me', callId: 'c1' });
  });
  it('accept', () => {
    const { ws, rc } = connected();
    rc.accept('c1', 'bob');
    expect(lastSent(ws)).toEqual({ t: 'accept', callId: 'c1', to: 'bob' });
  });
  it('reject', () => {
    const { ws, rc } = connected();
    rc.reject('c1', 'bob');
    expect(lastSent(ws)).toEqual({ t: 'reject', callId: 'c1', to: 'bob' });
  });
  it('cancel', () => {
    const { ws, rc } = connected();
    rc.cancel('c1', 'bob');
    expect(lastSent(ws)).toEqual({ t: 'cancel', callId: 'c1', to: 'bob' });
  });
  it('hangup', () => {
    const { ws, rc } = connected();
    rc.hangup('c1', 'bob');
    expect(lastSent(ws)).toEqual({ t: 'hangup', callId: 'c1', to: 'bob' });
  });
  it('reconnect', () => {
    const { ws, rc } = connected();
    rc.reconnect('c1', 'bob');
    expect(lastSent(ws)).toEqual({ t: 'reconnect', callId: 'c1', to: 'bob' });
  });
  it('sendMute', () => {
    const { ws, rc } = connected();
    rc.sendMute('bob', true);
    expect(lastSent(ws)).toEqual({ t: 'mute', to: 'bob', muted: true });
  });
});

describe('incoming message routing', () => {
  function connected() {
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    return { rc, ws: firstWs() };
  }

  it('maps server JSON messages to events', () => {
    const { rc, ws } = connected();
    const got = {};
    ['registered', 'incoming', 'accepted', 'rejected', 'cancelled', 'ended', 'busy',
     'peer-unavailable', 'reconnecting', 'reconnected', 'muted', 'id-taken']
      .forEach((t) => rc.on(t, (m) => { got[t] = m; }));
    ws.triggerMessage(JSON.stringify({ t: 'registered' }));
    ws.triggerMessage(JSON.stringify({ t: 'incoming', from: 'bob', callId: 'c1' }));
    ws.triggerMessage(JSON.stringify({ t: 'id-taken' }));
    ws.triggerMessage(JSON.stringify({ t: 'accepted', callId: 'c1', from: 'bob' }));
    ws.triggerMessage(JSON.stringify({ t: 'rejected', callId: 'c1' }));
    ws.triggerMessage(JSON.stringify({ t: 'cancelled', callId: 'c1' }));
    ws.triggerMessage(JSON.stringify({ t: 'ended', callId: 'c1' }));
    ws.triggerMessage(JSON.stringify({ t: 'busy', callId: 'c1' }));
    ws.triggerMessage(JSON.stringify({ t: 'peer-unavailable', callId: 'c1' }));
    ws.triggerMessage(JSON.stringify({ t: 'reconnecting', callId: 'c1' }));
    ws.triggerMessage(JSON.stringify({ t: 'reconnected', callId: 'c1' }));
    ws.triggerMessage(JSON.stringify({ t: 'muted', from: 'bob', muted: true }));
    expect(got.registered).toEqual({ t: 'registered' });
    expect(got.incoming).toEqual({ t: 'incoming', from: 'bob', callId: 'c1' });
    expect(got['id-taken']).toEqual({ t: 'id-taken' });
    expect(got.accepted).toEqual({ t: 'accepted', callId: 'c1', from: 'bob' });
    expect(got.rejected).toEqual({ t: 'rejected', callId: 'c1' });
    expect(got.cancelled).toEqual({ t: 'cancelled', callId: 'c1' });
    expect(got.ended).toEqual({ t: 'ended', callId: 'c1' });
    expect(got.busy).toEqual({ t: 'busy', callId: 'c1' });
    expect(got['peer-unavailable']).toEqual({ t: 'peer-unavailable', callId: 'c1' });
    expect(got.reconnecting).toEqual({ t: 'reconnecting', callId: 'c1' });
    expect(got.reconnected).toEqual({ t: 'reconnected', callId: 'c1' });
    expect(got.muted).toEqual({ t: 'muted', from: 'bob', muted: true });
  });

  it('ignores unknown message types', () => {
    const { rc, ws } = connected();
    let fired = false;
    rc.on('weird', () => { fired = true; });
    ws.triggerMessage(JSON.stringify({ t: 'pong' }));
    ws.triggerMessage(JSON.stringify({ t: 'unknown-thing' }));
    expect(fired).toBe(false);
  });

  it('emits audio events for binary frames', () => {
    const { rc, ws } = connected();
    const frames = [];
    rc.on('audio', (u) => frames.push(u));
    ws.triggerMessage(new Uint8Array([1, 2, 3]));
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0])).toEqual([1, 2, 3]);
  });
});

describe('sendAudio', () => {
  it('sends binary frames verbatim', () => {
    const rc = new RelayClient('wss://r');
    rc.connect('me');
    const ws = firstWs();
    ws.triggerOpen();
    rc.sendAudio(new Uint8Array([9, 8, 7]));
    expect(lastSent(ws)).toEqual({ _binary: true, data: new Uint8Array([9, 8, 7]) });
  });
});
