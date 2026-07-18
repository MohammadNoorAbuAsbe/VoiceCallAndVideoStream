// @vitest-environment jsdom
// Exhaustive tests for src/main.js — every handler, UI helper, call-lifecycle
// state, edge case and branch. RelayClient is a hoisted fake (records commands
// and lets us emit server events); audio.js is fully mocked so the wiring
// callbacks captured at import time exercise the real onFrame/onStarved logic.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupDom, setInput } from './helpers/dom.js';

// ─── Hoisted RelayClient fake (so the factory can capture the latest instance) ─
const hoist = vi.hoisted(() => {
  let lastRelay = null;
  class RelayClient {
    constructor(url) {
      this.url = url;
      this.id = null;
      this.token = null;
      this.connected = false;
      this.ws = { close() {} };
      this.listeners = new Map();
      this.calls = [];
      lastRelay = this;
    }
    on(type, cb) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(cb);
      return this;
    }
    emit(type, detail) {
      (this.listeners.get(type) || []).forEach((cb) => cb(detail));
    }
    connect(id, token, auth) {
      this.id = id;
      this.token = token || null;
      this.auth = auth || null;
      this.connected = true;
    }
    call(to, callId, offer)     { this.calls.push(['call', { to, callId, offer }]); }
    accept(callId, to, answer)  { this.calls.push(['accept', { callId, to, answer }]); }
    reject(callId, to)          { this.calls.push(['reject', { callId, to }]); }
    cancel(callId, to)          { this.calls.push(['cancel', { callId, to }]); }
    hangup(callId, to)          { this.calls.push(['hangup', { callId, to }]); }
    reconnect(callId, to)       { this.calls.push(['reconnect', { callId, to }]); }
    sendMute(to, muted)         { this.calls.push(['mute', { to, muted }]); }
    sendAudio(bytes)            { this.calls.push(['audio', bytes]); }
    send(data)                  { this.calls.push(['send', data]); }
    lastCall(name) {
      for (let i = this.calls.length - 1; i >= 0; i--)
        if (this.calls[i][0] === name) return this.calls[i][1];
      return undefined;
    }
    callCount(name) { return this.calls.filter((c) => c[0] === name).length; }
    clearCalls() { this.calls = []; }
  }
  return { RelayClient, getLastRelay: () => lastRelay };
});

vi.mock('../relay.js', () => ({ RelayClient: hoist.RelayClient }));

vi.mock('../audio.js', () => ({
  initCapture: vi.fn(async () => ({})),
  closeCapture: vi.fn(),
  setOnFrame: vi.fn(),
  setOnStarved: vi.fn(),
  setMuted: vi.fn(),
  setNoiseCancel: vi.fn(),
  isPlaybackReady: vi.fn(() => true),
  initPlayback: vi.fn(async () => {}),
  resumePlayback: vi.fn(async () => {}),
  isPlaybackSuspended: vi.fn(() => false),
  playBytes: vi.fn(),
  setOutputDevice: vi.fn(async () => {}),
  capture48ToWire: vi.fn((f) => f),
}));

import * as main from '../main.js';
import * as audio from '../audio.js';

// Captured once at import (audio.setOnFrame / setOnStarved invoked by main.js).
const frameCb = audio.setOnFrame.mock.calls[0][0];
const starvedCb = audio.setOnStarved.mock.calls[0][0];

const tick = () => new Promise((r) => setTimeout(r, 0));
// Poll until a condition holds — used because the call/audio paths now perform
// asynchronous crypto (identity load + key exchange + AES-GCM).
async function until(cond, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// A pass-through E2E session for exercising the encrypted audio path without a
// real key exchange: encrypt/decrypt are identity transforms.
function passthroughSession() {
  return {
    ready: true,
    encrypt: (x) => Promise.resolve(x),
    decrypt: (x) => Promise.resolve(x),
  };
}

function setupRelay() {
  main.__setMyId('me-test-id');
  main.initRelay();
  return hoist.getLastRelay();
}

// Minimal AudioContext mock (startRingtone builds oscillators/gains).
class FakeOsc {
  constructor() { this.frequency = {}; this.type = ''; }
  connect() {} start() {} stop() {}
}
class FakeGain {
  constructor() { this.gain = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
  connect() {}
}
let audioCtxCount = 0;
class FakeAudioCtx {
  constructor() { audioCtxCount++; this.currentTime = 0; this.destination = {}; this.state = 'running'; }
  createOscillator() { return new FakeOsc(); }
  createGain() { return new FakeGain(); }
  close() {}
}

beforeEach(() => {
  localStorage.clear();
  for (const k of Object.keys(audio)) {
    if (typeof audio[k]?.mockClear === 'function') audio[k].mockClear();
  }
  globalThis.AudioContext = FakeAudioCtx;
  if (!globalThis.HTMLMediaElement.prototype.play.__isMock) {
    globalThis.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    globalThis.HTMLMediaElement.prototype.play.__isMock = true;
  }
  setupDom();
  main.__resetState();
  // ensure a call-status-text node exists for status assertions
  const incall = document.getElementById('screen-incall');
  if (incall && !incall.querySelector('.call-status-text')) {
    const s = document.createElement('span');
    s.className = 'call-status-text';
    incall.appendChild(s);
  }
  audio.isPlaybackReady.mockReturnValue(true);
  audio.isPlaybackSuspended.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  try { main.stopRingtone(); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
describe('module import / wiring', () => {
  it('registers onFrame and onStarved callbacks at import', () => {
    expect(typeof frameCb).toBe('function');
    expect(typeof starvedCb).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('relay status + connection', () => {
  it('setRelayStatus updates text and class', () => {
    main.setRelayStatus(true, 'Connected');
    const el = document.getElementById('relay-status');
    expect(el.textContent).toBe('Connected');
    expect(el.className).toContain('online');
    main.setRelayStatus(false, 'Offline');
    expect(el.className).toContain('offline');
  });

  it('setRelayStatus no-ops when element missing', () => {
    document.getElementById('relay-status').remove();
    expect(() => main.setRelayStatus(true, 'x')).not.toThrow();
  });

  it('initRelay connects and registers handlers', () => {
    const relay = setupRelay();
    expect(relay.connected).toBe(true);
    expect(relay.listeners.size).toBeGreaterThan(0);
  });

  it('initRelay bails when URL is empty (no relay)', () => {
    const before = hoist.getLastRelay();
    main.__setDefaultRelayUrl('');
    setupRelay();
    expect(document.getElementById('relay-status').textContent).toBe('Relay URL not set');
    expect(document.getElementById('my-peer-id').textContent).toBe('me-test-id');
    expect(hoist.getLastRelay()).toBe(before); // no RelayClient was constructed
    main.__setDefaultRelayUrl('wss://voicecallandvideostream.onrender.com');
  });

  it('relay "open" sets status online', () => {
    const relay = setupRelay();
    relay.emit('open');
    expect(document.getElementById('relay-status').textContent).toBe('Connected');
  });

  it('relay "registered" with active call triggers reconnect', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    relay.emit('registered');
    expect(relay.callCount('reconnect')).toBe(1);
  });

  it('relay "registered" without active call does not reconnect', () => {
    const relay = setupRelay();
    relay.emit('registered');
    expect(relay.callCount('reconnect')).toBe(0);
  });

  it('relay "close" with active call marks reconnecting', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    relay.emit('close');
    expect(document.getElementById('reconnect-overlay').classList.contains('hidden')).toBe(false);
  });

  it('relay "audio" plays bytes and clears reconnecting flag', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.__setActiveSession(passthroughSession());
    relay.emit('close');
    // Incoming audio is a fixed-size batched blob (one 1052-byte frame here).
    const blob = new Uint8Array(1052);
    relay.emit('audio', blob);
    await until(() => audio.playBytes.mock.calls.length >= 1);
    expect(audio.playBytes).toHaveBeenCalledTimes(1);
    expect(audio.playBytes.mock.calls[0][0].byteLength).toBe(1052);
    expect(document.getElementById('reconnect-overlay').classList.contains('hidden')).toBe(true);
  });

  it('relay "id-taken" surfaces the collision instead of rotating the id', () => {
    const relay = setupRelay();
    const id = main.__getMyId();
    relay.emit('id-taken');
    expect(main.__getMyId()).toBe(id);
    expect(document.getElementById('reconnect-overlay').classList.contains('hidden')).toBe(true);
    expect(relay.connected).toBe(true);
  });

  it('getRelayUrl / getRelayToken read storage with defaults', () => {
    expect(main.getRelayUrl()).toBe('wss://voicecallandvideostream.onrender.com');
    expect(main.getRelayToken()).toBe('');
    localStorage.setItem(main.KEY_RELAY_URL, 'wss://example.com');
    localStorage.setItem(main.KEY_RELAY_TOKEN, 'tok');
    expect(main.getRelayUrl()).toBe('wss://example.com');
    expect(main.getRelayToken()).toBe('tok');
  });

  it('getMicDeviceId / getOutputDeviceId', () => {
    expect(main.getMicDeviceId()).toBe('');
    expect(main.getOutputDeviceId()).toBe('');
    localStorage.setItem(main.KEY_MIC_DEVICE, 'mic1');
    localStorage.setItem(main.KEY_OUTPUT_DEVICE, 'spk1');
    expect(main.getMicDeviceId()).toBe('mic1');
    expect(main.getOutputDeviceId()).toBe('spk1');
  });

  it('ensureIdentity creates and persists a key-derived id', async () => {
    localStorage.clear();
    const ident1 = await main.__ensureIdentity();
    expect(ident1.id).toBeTruthy();
    expect(localStorage.getItem(main.KEY_ID)).toBe(ident1.id);
    expect(localStorage.getItem(main.KEY_PUB)).toBeTruthy();
    const ident2 = await main.__ensureIdentity();
    expect(ident2.id).toBe(ident1.id); // stable across loads
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('UI helpers', () => {
  it('showScreen activates the target and deactivates others', () => {
    main.showScreen('screen-settings');
    expect(document.getElementById('screen-settings').classList.contains('active')).toBe(true);
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(false);
  });

  it('showToast shows error styling and resets', () => {
    vi.useFakeTimers();
    main.showToast('hi', true);
    const t = document.getElementById('toast');
    expect(t.textContent).toBe('hi');
    expect(t.className).toContain('error');
    vi.advanceTimersByTime(8000);
    expect(t.className).not.toContain('show');
  });

  it('renderContacts renders empty state', () => {
    localStorage.clear();
    main.renderContacts();
    expect(document.getElementById('contacts-list').innerHTML).toContain('No contacts yet');
  });

  it('renderContacts renders contact rows with call/del handlers', async () => {
    localStorage.setItem(
      'vcall_contacts',
      JSON.stringify([{ id: 'abc', name: 'Bob', lastCall: Date.now() }])
    );
    main.renderContacts();
    const list = document.getElementById('contacts-list');
    expect(list.innerHTML).toContain('Bob');
    expect(list.innerHTML).toContain('data-id="abc"');
    const relay = setupRelay();
    const callBtn = list.querySelector('.btn-call');
    callBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await until(() => relay.callCount('call') >= 1);
    expect(relay.callCount('call')).toBe(1);
    const delBtn = list.querySelector('.btn-del');
    delBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(JSON.parse(localStorage.getItem('vcall_contacts') || '[]').length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('incoming call', () => {
  it('handleIncoming stores pending and shows screen + rings', () => {
    setupRelay();
    document.getElementById('incoming-caller-name').textContent = '';
    main.handleIncoming({ from: 'peer', name: 'Peer', callId: 'c1' });
    expect(document.getElementById('screen-incoming').classList.contains('active')).toBe(true);
    expect(document.getElementById('incoming-caller-name').textContent).toContain('peer');
  });

  it('handleIncoming rejects when already active', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handleIncoming({ from: 'other', name: 'X', callId: 'c2' });
    expect(relay.callCount('reject')).toBe(1);
  });

  it('handleIncoming glare: we win (myId > from) → ignore', async () => {
    const relay = setupRelay();
    main.__setMyId('zzz');
    await main.startCall('aaa', 'A');
    main.handleIncoming({ from: 'aaa', name: 'A', callId: 'cWin' });
    expect(document.getElementById('screen-incoming').classList.contains('active')).toBe(false);
    main.cancelCall();
  });

  it('handleIncoming glare: we lose (myId < from) → cancel ours, auto-accept', async () => {
    const relay = setupRelay();
    main.__setMyId('aaa');
    await main.startCall('peer', 'Peer');
    main.handleIncoming({ from: 'peer', name: 'Peer', callId: 'cIn' });
    await until(() => relay.callCount('accept') >= 1);
    expect(relay.callCount('cancel')).toBe(1);
    expect(relay.lastCall('accept').callId).toBe('cIn');
    expect(relay.lastCall('accept').to).toBe('peer');
  });

  it('acceptCall no-ops without pending incoming', async () => {
    setupRelay();
    await main.acceptCall();
    expect(audio.initCapture).not.toHaveBeenCalled();
  });

  it('acceptCall accepts pending incoming', async () => {
    const relay = setupRelay();
    main.handleIncoming({ from: 'peer', name: 'Peer', callId: 'c1' });
    await main.acceptCall();
    await until(() => relay.callCount('accept') >= 1);
    expect(relay.lastCall('accept').callId).toBe('c1');
    expect(relay.lastCall('accept').to).toBe('peer');
    expect(document.getElementById('screen-incall').classList.contains('active')).toBe(true);
  });

  it('acceptIncomingInternal tolerates mic failure', async () => {
    const relay = setupRelay();
    audio.initCapture.mockRejectedValueOnce(new Error('no mic'));
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    expect(relay.lastCall('accept')).toEqual({ callId: 'c1', to: 'peer', answer: null });
    expect(document.getElementById('screen-incall').classList.contains('active')).toBe(true);
  });

  it('rejectCall rejects and returns to idle', () => {
    const relay = setupRelay();
    main.handleIncoming({ from: 'peer', name: 'Peer', callId: 'c1' });
    main.rejectCall();
    expect(relay.lastCall('reject')).toEqual({ callId: 'c1', to: 'peer' });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('ringtone re-rings after the interval, then stops', () => {
    vi.useFakeTimers();
    setupRelay();
    main.handleIncoming({ from: 'peer', name: 'Peer', callId: 'c1' });
    const before = audioCtxCount;
    vi.advanceTimersByTime(2200);
    expect(audioCtxCount).toBeGreaterThan(before); // ringOnce ran again
    vi.useRealTimers();
    main.stopRingtone();
    expect(document.getElementById('reconnect-overlay')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('outgoing call', () => {
  it('startCall blocks when relay URL missing', async () => {
    main.__setDefaultRelayUrl('');
    setupRelay();
    await main.startCall('peer', 'Peer');
    expect(audio.initCapture).not.toHaveBeenCalled();
    main.__setDefaultRelayUrl('wss://voicecallandvideostream.onrender.com');
  });

  it('startCall blocks when relay not connected', async () => {
    const relay = setupRelay();
    relay.connected = false;
    await main.startCall('peer', 'Peer');
    expect(audio.initCapture).not.toHaveBeenCalled();
  });

  it('startCall blocks when already in a call', async () => {
    const relay = setupRelay();
    await main.startCall('peer', 'Peer');
    audio.initCapture.mockClear();
    await main.startCall('other', 'Other');
    expect(audio.initCapture).not.toHaveBeenCalled();
  });

  it('startCall handles mic error', async () => {
    const relay = setupRelay();
    audio.initCapture.mockRejectedValueOnce(new Error('denied'));
    await main.startCall('peer', 'Peer');
    expect(relay.callCount('call')).toBe(0);
  });

  it('startCall succeeds, calls relay and sets noAnswer timer', async () => {
    vi.useFakeTimers();
    const relay = setupRelay();
    await main.startCall('peer', 'Peer');
    const c = relay.lastCall('call');
    expect(c.to).toBe('peer');
    expect(c.offer).toBeTruthy();
    expect(c.callId).toBeTruthy();
    expect(document.getElementById('screen-calling').classList.contains('active')).toBe(true);
    vi.advanceTimersByTime(41000);
    expect(relay.lastCall('cancel')).toBeTruthy();
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
    vi.useRealTimers();
  });

  it('cancelCall cancels a pending outgoing', async () => {
    const relay = setupRelay();
    await main.startCall('peer', 'Peer');
    main.cancelCall();
    expect(relay.lastCall('cancel')).toBeTruthy();
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('cancelCall no-ops when nothing pending', () => {
    const relay = setupRelay();
    main.cancelCall();
    expect(relay.callCount('cancel')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('call signalling handlers', () => {
  async function withPendingOutgoing(to = 'peer') {
    const relay = setupRelay();
    await main.startCall(to, 'Peer');
    const callId = relay.lastCall('call').callId;
    return { relay, callId };
  }

  it('handleAccepted transitions pending → active', async () => {
    const { relay, callId } = await withPendingOutgoing();
    main.handleAccepted({ callId });
    expect(document.getElementById('screen-incall').classList.contains('active')).toBe(true);
  });

  it('handleAccepted ignores mismatched callId', async () => {
    await withPendingOutgoing();
    main.handleAccepted({ callId: 'nope' });
    expect(document.getElementById('screen-incall').classList.contains('active')).toBe(false);
  });

  it('handleRejected cleans up', async () => {
    const { callId } = await withPendingOutgoing();
    main.handleRejected({ callId });
    expect(audio.closeCapture).toHaveBeenCalled();
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('handleRejected ignores mismatched', async () => {
    await withPendingOutgoing();
    main.handleRejected({ callId: 'x' });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(false);
  });

  it('handleCancelled cleans up', async () => {
    const { callId } = await withPendingOutgoing();
    main.handleCancelled({ callId });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('handleBusy cleans up with error toast', async () => {
    const { callId } = await withPendingOutgoing();
    main.handleBusy({ callId });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('handleUnavailable with active call ends it', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handleUnavailable({ callId: 'c1' });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('handleUnavailable with pending outgoing cleans up', async () => {
    const { callId } = await withPendingOutgoing();
    main.handleUnavailable({ callId });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('handleUnavailable mismatched → ignored', async () => {
    await withPendingOutgoing();
    main.handleUnavailable({ callId: 'z' });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(false);
  });

  it('handleEnded with active call (intentional) cleans up silently', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.hangUp();
    main.handleEnded({ callId: 'c1' });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('handleEnded with active call (not intentional) toasts', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handleEnded({ callId: 'c1' });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('handleEnded with pending incoming stops ringing and returns to idle', () => {
    const relay = setupRelay();
    main.handleIncoming({ from: 'peer', name: 'Peer', callId: 'c1' });
    main.handleEnded({ callId: 'c1' });
    expect(relay.callCount('reject')).toBe(0);
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('handleEnded mismatched → ignored', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handleEnded({ callId: 'zzz' });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reconnect + remote mute', () => {
  it('handlePeerReconnecting shows overlay and schedules self-reconnect', async () => {
    vi.useFakeTimers();
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handlePeerReconnecting({ callId: 'c1' });
    expect(document.getElementById('reconnect-overlay').classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(relay.callCount('reconnect')).toBe(1);
    vi.useRealTimers();
  });

  it('handlePeerReconnecting mismatched → ignored', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handlePeerReconnecting({ callId: 'zzz' });
    expect(document.getElementById('reconnect-overlay').classList.contains('hidden')).toBe(true);
  });

  it('handleReconnected clears overlay', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handlePeerReconnecting({ callId: 'c1' });
    main.handleReconnected({ callId: 'c1' });
    expect(document.getElementById('reconnect-overlay').classList.contains('hidden')).toBe(true);
  });

  it('handleReconnected mismatched → ignored', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handleReconnected({ callId: 'zzz' });
    expect(document.getElementById('reconnect-overlay').classList.contains('hidden')).toBe(true);
  });

  it('handleRemoteMuted toggles indicator', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handleRemoteMuted({ from: 'peer', muted: true });
    expect(document.getElementById('incall-remote-mute').textContent).toBe('Muted');
    main.handleRemoteMuted({ from: 'peer', muted: false });
    expect(document.getElementById('incall-remote-mute').textContent).toBe('');
  });

  it('handleRemoteMuted mismatched peer → ignored', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.handleRemoteMuted({ from: 'other', muted: true });
    expect(document.getElementById('incall-remote-mute').textContent).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('hang up / cleanup', () => {
  it('hangUp sends hangup and cleans up', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.hangUp();
    expect(relay.lastCall('hangup')).toEqual({ callId: 'c1', to: 'peer' });
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('hangUp with no active call still cleans up', () => {
    const relay = setupRelay();
    main.hangUp();
    expect(relay.callCount('hangup')).toBe(0);
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('endCallCleanup with message shows toast', () => {
    setupRelay();
    main.endCallCleanup('bye');
    expect(document.getElementById('toast').textContent).toBe('bye');
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('endCallCleanup without message does not toast', () => {
    setupRelay();
    document.getElementById('toast').className = 'toast';
    main.endCallCleanup();
    expect(document.getElementById('toast').className).not.toContain('show');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('mute / noise cancel / in-call buttons', () => {
  it('toggleMute flips and notifies relay', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.toggleMute();
    expect(audio.setMuted).toHaveBeenCalledWith(true);
    expect(relay.lastCall('mute')).toEqual({ to: 'peer', muted: true });
    expect(document.getElementById('icon-mic').classList.contains('hidden')).toBe(true);
    main.toggleMute();
    expect(audio.setMuted).toHaveBeenCalledWith(false);
  });

  it('toggleMute with no active call is a no-op', () => {
    setupRelay();
    main.toggleMute();
    expect(audio.setMuted).not.toHaveBeenCalled();
  });

  it('toggleNoiseCancellation toggles and toasts', () => {
    setupRelay();
    main.toggleNoiseCancellation();
    expect(audio.setNoiseCancel).toHaveBeenCalledWith(false);
    expect(document.getElementById('btn-noise-cancel').classList.contains('nc-off')).toBe(true);
    main.toggleNoiseCancellation();
    expect(audio.setNoiseCancel).toHaveBeenCalledWith(true);
  });

  it('resetInCallButtons resets UI', async () => {
    setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.toggleMute();
    main.resetInCallButtons();
    expect(document.getElementById('icon-mic').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('call-timer').textContent).toBe('00:00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('audio playback helpers', () => {
  it('ensureAudioPlaying resumes when ready', async () => {
    setupRelay();
    audio.isPlaybackReady.mockReturnValue(true);
    await main.ensureAudioPlaying();
    expect(audio.resumePlayback).toHaveBeenCalled();
  });

  it('ensureAudioPlaying inits when not ready', async () => {
    setupRelay();
    audio.isPlaybackReady.mockReturnValue(false);
    await main.ensureAudioPlaying();
    expect(audio.initPlayback).toHaveBeenCalled();
  });

  it('ensureAudioPlaying shows enable-sound when suspended', async () => {
    setupRelay();
    audio.isPlaybackReady.mockReturnValue(true);
    audio.isPlaybackSuspended.mockReturnValue(true);
    await main.ensureAudioPlaying();
    expect(document.getElementById('btn-enable-sound').classList.contains('hidden')).toBe(false);
  });

  it('ensureAudioPlaying hides enable-sound when not suspended', async () => {
    setupRelay();
    audio.isPlaybackReady.mockReturnValue(true);
    audio.isPlaybackSuspended.mockReturnValue(false);
    await main.ensureAudioPlaying();
    expect(document.getElementById('btn-enable-sound').classList.contains('hidden')).toBe(true);
  });

  it('ensureAudioPlaying swallows init error', async () => {
    setupRelay();
    audio.isPlaybackReady.mockReturnValue(false);
    audio.initPlayback.mockRejectedValueOnce(new Error('x'));
    await expect(main.ensureAudioPlaying()).resolves.toBeUndefined();
  });

  it('showEnableSound / hideEnableSound toggle class', () => {
    setupRelay();
    main.showEnableSound();
    expect(document.getElementById('btn-enable-sound').classList.contains('hidden')).toBe(false);
    main.hideEnableSound();
    expect(document.getElementById('btn-enable-sound').classList.contains('hidden')).toBe(true);
  });

  it('enableSoundTapped resumes and hides', async () => {
    setupRelay();
    await main.enableSoundTapped();
    expect(audio.resumePlayback).toHaveBeenCalled();
    expect(document.getElementById('btn-enable-sound').classList.contains('hidden')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('call timer', () => {
  it('startCallTimer ticks and formats', () => {
    vi.useFakeTimers();
    setupRelay();
    main.startCallTimer();
    vi.advanceTimersByTime(61000);
    expect(document.getElementById('call-timer').textContent).toBe('01:01');
    main.stopCallTimer();
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('mic errors', () => {
  it('maps NotAllowedError', () => {
    setupRelay();
    main.handleMicError({ name: 'NotAllowedError', message: 'x' });
    expect(document.getElementById('toast').textContent).toContain('Microphone access denied');
  });
  it('maps NotFoundError', () => {
    setupRelay();
    main.handleMicError({ name: 'NotFoundError', message: 'x' });
    expect(document.getElementById('toast').textContent).toContain('No microphone found');
  });
  it('falls back to message', () => {
    setupRelay();
    main.handleMicError({ name: 'Other', message: 'boom' });
    expect(document.getElementById('toast').textContent).toContain('boom');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('device settings', () => {
  it('populateDeviceSelects builds options', async () => {
    setupRelay();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
        enumerateDevices: vi.fn(async () => ([
          { kind: 'audioinput', deviceId: 'm1', label: 'Mic1' },
          { kind: 'audiooutput', deviceId: 's1', label: 'Spk1' },
        ])),
      },
    });
    localStorage.setItem(main.KEY_MIC_DEVICE, 'm1');
    localStorage.setItem(main.KEY_OUTPUT_DEVICE, 's1');
    await main.populateDeviceSelects();
    expect(document.getElementById('select-mic').innerHTML).toContain('m1');
    expect(document.getElementById('select-output').innerHTML).toContain('s1');
  });

  it('populateDeviceSelects handles no devices', async () => {
    setupRelay();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
        enumerateDevices: vi.fn(async () => []),
      },
    });
    await main.populateDeviceSelects();
    expect(document.getElementById('select-mic').innerHTML).toContain('No microphones found');
    expect(document.getElementById('select-output').innerHTML).toContain('No output devices found');
  });

  it('applyOutputDevice calls audio.setOutputDevice', async () => {
    setupRelay();
    localStorage.setItem(main.KEY_OUTPUT_DEVICE, 's1');
    await main.applyOutputDevice();
    expect(audio.setOutputDevice).toHaveBeenCalledWith('s1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('mute keybind', () => {
  it('get/set keybind round-trips', () => {
    expect(main.getMuteKeybind()).toBe(null);
    const kb = { code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false };
    main.setMuteKeybind(kb);
    expect(main.getMuteKeybind()).toEqual(kb);
    main.setMuteKeybind(null);
    expect(main.getMuteKeybind()).toBe(null);
  });

  it('getMuteKeybind tolerates corrupt json', () => {
    localStorage.setItem(main.KEY_MUTE_KEYBIND, '{bad');
    expect(main.getMuteKeybind()).toBe(null);
  });

  it('updateKeybindDisplay renders and clears listening', () => {
    setupRelay();
    const kb = { code: 'KeyM', ctrl: true, shift: false, alt: false, meta: false };
    main.setMuteKeybind(kb);
    main.updateKeybindDisplay();
    expect(document.getElementById('keybind-display').textContent).toContain('Ctrl');
  });

  it('startKeybindCapture records a key and ignores modifiers', () => {
    setupRelay();
    main.startKeybindCapture();
    expect(main.getKeybindCapturing()).toBe(true);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true }));
    expect(main.getKeybindCapturing()).toBe(true);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', code: 'KeyM', bubbles: true }));
    expect(main.getMuteKeybind()).toEqual({ code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false });
    expect(main.getKeybindCapturing()).toBe(false);
  });

  it('startKeybindCapture Escape cancels', () => {
    setupRelay();
    main.startKeybindCapture();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    expect(main.getKeybindCapturing()).toBe(false);
    expect(main.getMuteKeybind()).toBe(null);
  });

  it('startKeybindCapture ignores when already capturing', () => {
    setupRelay();
    main.startKeybindCapture();
    const before = main.getKeybindCapturing();
    main.startKeybindCapture();
    expect(main.getKeybindCapturing()).toBe(before);
    // clean up the still-registered capture listener so it doesn't block others
    document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyX', key: 'x', bubbles: true }));
    expect(main.getKeybindCapturing()).toBe(false);
  });

  it('global keydown toggles mute when keybind matches', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.setMuteKeybind({ code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false });
    document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
    expect(relay.lastCall('mute')).toEqual({ to: 'peer', muted: true });
  });

  it('global keydown ignores when focus in input', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.setMuteKeybind({ code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', bubbles: true }));
    expect(relay.callCount('mute')).toBe(0);
  });

  it('global keydown ignores when no keybind set', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.setMuteKeybind(null);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', bubbles: true }));
    expect(relay.callCount('mute')).toBe(0);
  });

  it('global keydown shows toast when not on incall screen', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.showScreen('screen-idle');
    main.setMuteKeybind({ code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false });
    document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
    expect(relay.lastCall('mute')).toEqual({ to: 'peer', muted: true });
    expect(document.getElementById('toast').textContent).toContain('Mic muted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('copy id / save contact', () => {
  it('copyMyId no-ops when id not ready', async () => {
    setupRelay();
    main.__resetState();
    await main.copyMyId();
    expect(document.getElementById('toast').textContent).toContain('ID not ready');
  });

  it('copyMyId copies and resets label', async () => {
    vi.useFakeTimers();
    setupRelay();
    main.__setMyId('my-id-123');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
    await main.copyMyId();
    expect(document.getElementById('btn-copy-my-id').textContent).toBe('Copied!');
    vi.advanceTimersByTime(2000);
    expect(document.getElementById('btn-copy-my-id').textContent).toBe('Copy');
    vi.useRealTimers();
  });

  it('copyMyId handles clipboard failure', async () => {
    setupRelay();
    main.__setMyId('my-id-123');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('no'); }) },
    });
    await main.copyMyId();
    expect(document.getElementById('toast').textContent).toContain('Could not copy');
  });

  it('saveContact blocks empty name', () => {
    setupRelay();
    setInput('contact-name-input', '  ');
    setInput('contact-id-input', 'id1');
    main.saveContact();
    expect(document.getElementById('toast').textContent).toContain('Enter a name');
  });

  it('saveContact blocks empty id', () => {
    setupRelay();
    setInput('contact-name-input', 'Bob');
    setInput('contact-id-input', '  ');
    main.saveContact();
    expect(document.getElementById('toast').textContent).toContain("friend's ID");
  });

  it('saveContact blocks own id', () => {
    setupRelay();
    main.__setMyId('my-own-id');
    setInput('contact-name-input', 'Me');
    setInput('contact-id-input', 'my-own-id');
    main.saveContact();
    expect(document.getElementById('toast').textContent).toContain('your own ID');
  });

  it('saveContact adds contact and returns to idle', () => {
    setupRelay();
    setInput('contact-name-input', 'Bob');
    setInput('contact-id-input', 'friend-id');
    main.saveContact();
    const contacts = JSON.parse(localStorage.getItem('vcall_contacts') || '[]');
    expect(contacts.length).toBe(1);
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('audio frame wiring (onFrame / onStarved)', () => {
  it('onFrame sends audio only when in active connected call', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.__setActiveSession(passthroughSession());
    const frame = new Float32Array(8);
    await frameCb(frame);
    // frames are batched and flushed (via a short timer) as one binary blob
    await until(() => relay.callCount('audio') >= 1);
    expect(relay.lastCall('audio')).toBe(frame);
  });

  it('onFrame drops when no active call', () => {
    setupRelay();
    frameCb(new Float32Array(8));
    expect(hoist.getLastRelay().callCount('audio')).toBe(0);
  });

  it('relay "audio" splits a multi-frame blob into per-frame playbacks', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.__setActiveSession(passthroughSession());
    // Three fixed-size frames concatenated into one binary message.
    relay.emit('audio', new Uint8Array(1052 * 3));
    await until(() => audio.playBytes.mock.calls.length >= 3);
    expect(audio.playBytes).toHaveBeenCalledTimes(3);
    for (const call of audio.playBytes.mock.calls) {
      expect(call[0].byteLength).toBe(1052);
    }
  });

  it('onFrame drops when relay disconnected', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    relay.connected = false;
    frameCb(new Float32Array(8));
    expect(relay.callCount('audio')).toBe(0);
  });

  it('onStarved records start and sets status after sustained starve', async () => {
    vi.useFakeTimers();
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    starvedCb(true);
    expect(main.getStarveStart()).toBeGreaterThan(0);
    vi.advanceTimersByTime(1600);
    starvedCb(true);
    expect(document.querySelector('#screen-incall .call-status-text').textContent).toContain('No audio');
    vi.useRealTimers();
  });

  it('onStarved does not set status while reconnecting', async () => {
    vi.useFakeTimers();
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    relay.emit('close');
    starvedCb(true);
    vi.advanceTimersByTime(1600);
    starvedCb(true);
    expect(document.querySelector('#screen-incall .call-status-text').textContent).not.toContain('No audio');
    vi.useRealTimers();
  });

  it('onStarved clears status when audio resumes', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    starvedCb(true);
    starvedCb(false);
    expect(main.getStarveStart()).toBe(0);
  });

  it('onStarved ignores when there is no active call', () => {
    setupRelay();
    expect(() => starvedCb(true)).not.toThrow();
    expect(main.getStarveStart()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('defensive / edge branches', () => {
  it('startRingtone is idempotent (already active → early return)', () => {
    setupRelay();
    main.startRingtone();
    main.startRingtone(); // early return — covers the active guard
    main.stopRingtone();
  });

  it('startCall with empty peer name uses fallback avatar', async () => {
    const relay = setupRelay();
    await main.startCall('peer', '');
    expect(document.getElementById('calling-avatar').textContent).toBe('?');
    main.cancelCall();
  });

  it('handleRejected with no pending outgoing is a no-op', () => {
    setupRelay();
    main.handleRejected({ callId: 'x' });
    expect(audio.closeCapture).not.toHaveBeenCalled();
  });

  it('handleCancelled with no pending outgoing is a no-op', () => {
    setupRelay();
    main.handleCancelled({ callId: 'x' });
    expect(audio.closeCapture).not.toHaveBeenCalled();
  });

  it('handleRejected with pending but mismatched callId is a no-op', async () => {
    const relay = setupRelay();
    await main.startCall('peer', 'Peer');
    const callId = relay.lastCall('call').callId;
    main.handleRejected({ callId: callId + '-x' });
    expect(audio.closeCapture).not.toHaveBeenCalled();
  });

  it('handleEnded with intentionalHangup flag set uses quiet cleanup', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.__setIntentionalHangup(true);
    main.handleEnded({ callId: 'c1' });
    expect(audio.closeCapture).toHaveBeenCalled();
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);
  });

  it('ringtone auto-replays and stopRingtone closes the context', () => {
    vi.useFakeTimers();
    setupRelay();
    main.startRingtone();
    vi.advanceTimersByTime(2200); // fires the reschedule timer → closes + re-rings
    vi.advanceTimersByTime(2200);
    main.stopRingtone();
    vi.useRealTimers();
    expect(document.title).not.toContain('Incoming');
  });

  it('global keydown toggles mute off and toasts "Mic unmuted"', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    main.showScreen('screen-idle'); // incall screen inactive → mute keybind toasts
    main.setMuteKeybind({ code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false });
    document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
    document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
    expect(relay.lastCall('mute')).toEqual({ to: 'peer', muted: false });
    expect(document.getElementById('toast').textContent).toContain('Mic unmuted');
  });

  it('populateDeviceSelects tolerates getUserMedia failure and empty labels', async () => {
    setupRelay();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => { throw new Error('denied'); }),
        enumerateDevices: vi.fn(async () => ([
          { kind: 'audioinput', deviceId: 'm1', label: '' },
          { kind: 'audiooutput', deviceId: 's1', label: '' },
        ])),
      },
    });
    await main.populateDeviceSelects();
    expect(document.getElementById('select-mic').innerHTML).toContain('m1');
    expect(document.getElementById('select-mic').innerHTML).toContain('Microphone 1');
    expect(document.getElementById('select-output').innerHTML).toContain('Speaker 1');
  });

  it('updateKeybindDisplay no-ops when element is missing', () => {
    setupRelay();
    document.getElementById('keybind-display').remove();
    expect(() => main.updateKeybindDisplay()).not.toThrow();
  });

  it('global keydown with missing incall screen still toggles + toasts', async () => {
    const relay = setupRelay();
    await main.acceptIncomingInternal('c1', 'peer', 'Peer', false);
    // Reparent in-call controls so removing the screen doesn't break toggleMute,
    // then drop the screen to exercise the getElementById('screen-incall')?. branch.
    ['icon-mic', 'icon-mic-off', 'btn-mute'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) document.body.appendChild(el);
    });
    document.getElementById('screen-incall').remove();
    main.setMuteKeybind({ code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false });
    document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
    expect(relay.lastCall('mute')).toEqual({ to: 'peer', muted: true });
    expect(document.getElementById('toast').textContent).toContain('Mic muted');
  });

  function fireBootstrap() {
    const deviceListeners = {};
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
        enumerateDevices: vi.fn(async () => []),
        addEventListener: (t, cb) => { deviceListeners[t] = cb; },
      },
    });
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    return deviceListeners;
  }

  it('btn-save-relay with no existing relay still re-inits', () => {
    fireBootstrap();
    main.__resetState(); // relay = null
    document.getElementById('relay-url-input').value = 'wss://x.com';
    document.getElementById('relay-token-input').value = 't';
    document.getElementById('btn-save-relay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(localStorage.getItem(main.KEY_RELAY_URL)).toBe('wss://x.com');
    expect(hoist.getLastRelay().connected).toBe(true);
  });

  it('btn-save-relay skips closing when relay has no ws', () => {
    fireBootstrap();
    const relay = setupRelay();
    relay.ws = null;
    document.getElementById('relay-url-input').value = 'wss://y.com';
    document.getElementById('relay-token-input').value = 't';
    document.getElementById('btn-save-relay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(localStorage.getItem(main.KEY_RELAY_URL)).toBe('wss://y.com');
  });

  it('btn-save-relay closes an existing relay ws before reconnecting', () => {
    fireBootstrap();
    const relay = setupRelay();
    const closeSpy = vi.fn();
    relay.ws = { close: closeSpy };
    document.getElementById('relay-url-input').value = 'wss://z.com';
    document.getElementById('relay-token-input').value = 't';
    document.getElementById('btn-save-relay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(closeSpy).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('app bootstrap (DOMContentLoaded)', () => {
  it('wires UI controls and refreshes devices on devicechange', async () => {
    setupRelay();
    const deviceListeners = {};
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
        enumerateDevices: vi.fn(async () => []),
        addEventListener: (type, cb) => { deviceListeners[type] = cb; },
      },
    });

    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await until(() => document.getElementById('my-peer-id').textContent);
    expect(document.getElementById('my-peer-id').textContent).toBeTruthy();

    // open settings (also calls populateDeviceSelects)
    document.getElementById('btn-open-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('screen-settings').classList.contains('active')).toBe(true);

    // devicechange while NOT on settings -> no refresh
    deviceListeners.devicechange();
    // devicechange while on settings -> refreshes
    deviceListeners.devicechange();

    // back to idle
    document.getElementById('btn-back-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);

    // add-contact screen round trip
    document.getElementById('btn-add-contact').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('screen-add-contact').classList.contains('active')).toBe(true);
    document.getElementById('btn-back-add').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('screen-idle').classList.contains('active')).toBe(true);

    // copy id + clear keybind buttons
    main.__setMyId('id-x');
    document.getElementById('btn-copy-my-id').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    main.setMuteKeybind({ code: 'KeyM', ctrl: false, shift: false, alt: false, meta: false });
    document.getElementById('btn-clear-keybind').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(main.getMuteKeybind()).toBe(null);

    // save relay re-inits the connection
    const relay = setupRelay();
    document.getElementById('relay-url-input').value = 'wss://example.com';
    document.getElementById('relay-token-input').value = 'tok';
    document.getElementById('btn-save-relay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(localStorage.getItem(main.KEY_RELAY_URL)).toBe('wss://example.com');

    // output device change persists + applies
    const outSel = document.getElementById('select-output');
    const opt = document.createElement('option');
    opt.value = 'spk1';
    outSel.appendChild(opt);
    outSel.value = 'spk1';
    outSel.dispatchEvent(new window.Event('change'));
    expect(localStorage.getItem(main.KEY_OUTPUT_DEVICE)).toBe('spk1');

    // set-keybind button: start capture, then cancel capture
    document.getElementById('btn-set-keybind').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(main.getKeybindCapturing()).toBe(true);
    document.getElementById('btn-set-keybind').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(main.getKeybindCapturing()).toBe(false);

    // refresh devices button
    document.getElementById('btn-refresh-devices').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
});
