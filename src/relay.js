// ─────────────────────────────────────────────────────────────────────────────
//  Relay client — WebSocket connection + signaling protocol.
//
//  Registration is a two-step challenge/response: the client sends its id +
//  public key, the server replies with a random `challenge`, and the client
//  signs it (via the injected `auth.sign` callback) to prove it owns the id.
//  Emits events the UI subscribes to via `on(type, cb)`.
// ─────────────────────────────────────────────────────────────────────────────

import { b64ToBytes } from './crypto.js';

export class RelayClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = null;
    this.token = null;
    this.auth = null;          // { pubKeyB64, sign(nonceBytes) => Promise<sigB64> }
    this.connected = false;
    this.reconnectTimer = null;
    this.heartbeat = null;
    this.listeners = new Map();
  }

  // Register an event listener for a type. Returns `this` for chaining.
  on(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
    return this;
  }
  _emit(type, detail) {
    (this.listeners.get(type) || []).forEach(cb => cb(detail));
  }

  // Open the connection. `auth` carries the public key + a signer used to
  // answer the server's registration challenge.
  connect(id, token, auth) {
    this.id = id;
    this.token = token || null;
    this.auth = auth || null;
    this._open();
  }

  _open() {
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) { this._scheduleReconnect(); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.connected = true;
      this._send({ t: 'register', id: this.id, token: this.token, pubKey: this.auth ? this.auth.pubKeyB64 : undefined });
      this._emit('open');
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this._send({ t: 'ping' }), 20000);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        this._onMessage(m);
      } else {
        this._emit('audio', new Uint8Array(ev.data));
      }
    };

    ws.onclose = () => {
      this.connected = false;
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      this._emit('close');
      if (this.id) this._scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), 2000);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // Sign the server's challenge nonce and return the auth response.
  async _answerChallenge(nonceB64) {
    if (!this.auth || typeof this.auth.sign !== 'function') return;
    try {
      const sig = await this.auth.sign(b64ToBytes(nonceB64));
      this._send({ t: 'auth', sig });
    } catch { /* signing failed — server will time us out */ }
  }

  sendAudio(bytes) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  _onMessage(m) {
    switch (m.t) {
      case 'challenge':         return this._answerChallenge(m.nonce);
      case 'registered':        this._emit('registered', m); break;
      case 'register-denied':   this._emit('register-denied', m); break;
      case 'id-taken':          this._emit('id-taken', m); break;
      case 'incoming':          this._emit('incoming', m); break;
      case 'accepted':          this._emit('accepted', m); break;
      case 'rejected':          this._emit('rejected', m); break;
      case 'cancelled':         this._emit('cancelled', m); break;
      case 'ended':             this._emit('ended', m); break;
      case 'busy':              this._emit('busy', m); break;
      case 'peer-unavailable':  this._emit('peer-unavailable', m); break;
      case 'reconnecting':      this._emit('reconnecting', m); break;
      case 'reconnected':       this._emit('reconnected', m); break;
      case 'muted':             this._emit('muted', m); break;
      default: break; // pong, etc.
    }
  }

  // ── commands ──
  call(to, callId, offer)   { this._send({ t: 'call', to, callId, offer }); }
  accept(callId, to, answer){ this._send({ t: 'accept', callId, to, answer }); }
  reject(callId, to)        { this._send({ t: 'reject', callId, to }); }
  cancel(callId, to)        { this._send({ t: 'cancel', callId, to }); }
  hangup(callId, to)        { this._send({ t: 'hangup', callId, to }); }
  reconnect(callId, to)     { this._send({ t: 'reconnect', callId, to }); }
  sendMute(to, muted)       { this._send({ t: 'mute', to, muted }); }
}
