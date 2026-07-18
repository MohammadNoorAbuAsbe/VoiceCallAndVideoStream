// ─────────────────────────────────────────────────────────────────────────────
//  Relay client — WebSocket connection + signaling protocol.
//  Emits events the UI subscribes to via `on(type, cb)`.
// ─────────────────────────────────────────────────────────────────────────────

export class RelayClient {
  // @illusion: init WebSocket relay client with URL, state, and event listeners map
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = null;
    this.token = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.heartbeat = null;
    this.listeners = new Map();
  }

  // @illusion: register event listener for a given type, returns this for chaining
  on(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
    return this;
  }
  // @illusion: fire all registered listeners for an event type with detail payload
  _emit(type, detail) {
    (this.listeners.get(type) || []).forEach(cb => cb(detail));
  }

  // @illusion: set peer ID and token, then open WebSocket connection
  connect(id, token) {
    this.id = id;
    this.token = token || null;
    this._open();
  }

  // @illusion: open WebSocket, wire onopen/onmessage/onclose/onerror, start heartbeat
  _open() {
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) { this._scheduleReconnect(); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.connected = true;
      this._send({ t: 'register', id: this.id, token: this.token });
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

  // @illusion: schedule WebSocket reconnect attempt after 2-second delay
  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), 2000);
  }

  // @illusion: send JSON message via WebSocket if connection is open
  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // @illusion: send binary audio frame via WebSocket
  sendAudio(bytes) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  // @illusion: dispatch incoming JSON message by type to registered event listeners
  _onMessage(m) {
    switch (m.t) {
      case 'registered':        this._emit('registered', m); break;
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
      default: break; // pong, register-denied, etc.
    }
  }

  // ── commands ──
  // @illusion: send call signaling message to peer
  call(to, name, callId)    { this._send({ t: 'call', to, name, callId }); }
  // @illusion: send accept response to incoming call
  accept(callId, to)        { this._send({ t: 'accept', callId, to }); }
  // @illusion: send reject response to incoming call
  reject(callId, to)        { this._send({ t: 'reject', callId, to }); }
  // @illusion: cancel pending outgoing call
  cancel(callId, to)        { this._send({ t: 'cancel', callId, to }); }
  // @illusion: hang up active call
  hangup(callId, to)        { this._send({ t: 'hangup', callId, to }); }
  // @illusion: request reconnection of dropped call
  reconnect(callId, to)     { this._send({ t: 'reconnect', callId, to }); }
  // @illusion: notify peer of mute state change
  sendMute(to, muted)       { this._send({ t: 'mute', to, muted }); }
}
