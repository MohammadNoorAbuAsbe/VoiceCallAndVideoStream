// A controllable fake of the RelayClient used by main.js tests.
// It records command calls and lets the test emit server events.

export class FakeRelayClient {
  constructor(url) {
    this.url = url;
    this.id = null;
    this.token = null;
    this.connected = false;
    this.ws = { close() {} };
    this.listeners = new Map();
    this.calls = []; // recorded command invocations
    this.connectedId = null;
  }

  on(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
    return this;
  }

  emit(type, detail) {
    (this.listeners.get(type) || []).forEach((cb) => cb(detail));
  }

  connect(id, token) {
    this.id = id;
    this.token = token || null;
    this.connected = true;
    this.connectedId = id;
  }

  // ── commands (recorded) ──
  call(to, callId, offer)    { this.calls.push(['call', { to, callId, offer }]); }
  accept(callId, to)        { this.calls.push(['accept', { callId, to }]); }
  reject(callId, to)        { this.calls.push(['reject', { callId, to }]); }
  cancel(callId, to)        { this.calls.push(['cancel', { callId, to }]); }
  hangup(callId, to)        { this.calls.push(['hangup', { callId, to }]); }
  reconnect(callId, to)     { this.calls.push(['reconnect', { callId, to }]); }
  sendMute(to, muted)       { this.calls.push(['mute', { to, muted }]); }
  sendAudio(bytes)          { this.calls.push(['audio', bytes]); }
  send(data)                { this.calls.push(['send', data]); }

  // test helpers
  lastCall(name) {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i][0] === name) return this.calls[i][1];
    }
    return undefined;
  }
  callCount(name) {
    return this.calls.filter((c) => c[0] === name).length;
  }
  clearCalls() { this.calls = []; }
}
