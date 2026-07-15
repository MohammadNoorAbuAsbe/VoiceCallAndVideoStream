// ─────────────────────────────────────────────────────────────────────────────
//  VoiceCall Relay Server
//
//  A tiny WebSocket relay. Clients connect outbound (works through any NAT /
//  firewall — no ICE / TURN / WebRTC needed). The server maps a peer "id" to a
//  socket, forwards call-signaling messages, and shuttles raw binary audio
//  frames between the two peers in a call. It does NOT decode or process audio.
//
//  Protocol (JSON unless marked binary):
//    Client → Server
//      register {id, token?}
//      call     {to, name, callId}
//      accept   {callId, to}
//      reject   {callId, to}
//      cancel   {callId, to}
//      hangup   {callId, to}
//      reconnect{callId, to}
//      mute     {to, muted}
//      ping
//      <binary>            → audio frame (forwarded to current call peer)
//    Server → Client
//      registered {id}
//      id-taken   {id}
//      incoming   {from, name, callId}
//      accepted   {callId, from, name}
//      rejected   {callId}
//      cancelled  {callId}
//      ended      {callId}
//      busy       {callId}
//      peer-unavailable {callId}
//      reconnecting {callId}
//      reconnected  {callId}
//      muted      {from, muted}
//      pong
//
//  Env:
//    PORT        (default 3000)
//    RELAY_TOKEN (optional; if set, clients must register with the same token)
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.RELAY_TOKEN || '';

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

const wss = new WebSocketServer({ server: httpServer });

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

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.id = null;          // registered id
  ws.currentCall = null; // callId of the active call (set after accept)
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

function handleMessage(ws, m) {
  switch (m.t) {
    case 'register': {
      if (TOKEN && m.token !== TOKEN) { send(ws, { t: 'register-denied' }); ws.close(); return; }
      const id = String(m.id || '').trim();
      if (!id || clients.has(id)) { send(ws, { t: 'id-taken', id }); return; }
      ws.id = id;
      clients.set(id, ws);
      send(ws, { t: 'registered', id });
      console.log(`[+] ${id} registered (${clients.size} online)`);
      break;
    }

    case 'call': {
      const { to, name, callId } = m;
      if (!ws.id) return;
      if (to === ws.id) return; // can't call yourself
      const target = clients.get(to);
      if (!target) { send(ws, { t: 'peer-unavailable', callId }); return; }
      if (target.currentCall) { send(ws, { t: 'busy', callId }); return; }
      ws.pendingOutgoing = { to, callId };
      send(target, { t: 'incoming', from: ws.id, name: name || ws.id, callId });
      break;
    }

    case 'accept': {
      const { callId, to } = m;
      const caller = clients.get(to);
      if (!caller) { send(ws, { t: 'peer-unavailable', callId }); return; }
      calls.set(callId, { a: ws.id, b: to, accepted: true, dropTimer: null });
      ws.currentCall = callId;
      caller.currentCall = callId;
      ws.pendingOutgoing = null;
      caller.pendingOutgoing = null;
      send(caller, { t: 'accepted', callId, from: ws.id, name: ws.id });
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

function handleAudio(ws, data) {
  const callId = ws.currentCall;
  if (!callId) return;
  const call = calls.get(callId);
  if (!call) return;
  const peerId = call.a === ws.id ? call.b : call.a;
  sendBin(clients.get(peerId), data);
}

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
    // Give the dropped peer a grace window to reconnect before tearing down.
    call.dropTimer = setTimeout(() => {
      calls.delete(callId);
      if (peer) { peer.currentCall = null; send(peer, { t: 'ended', callId }); }
    }, 30000);
  }
}

// Heartbeat: drop sockets that stop responding.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`VoiceCall relay listening on :${PORT}${TOKEN ? ' (token required)' : ''}`);
});
