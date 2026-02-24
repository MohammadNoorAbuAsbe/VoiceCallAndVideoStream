// ─────────────────────────────────────────────────────────────────────────────
//  VoiceCall — PeerJS-based, auto-signaling, no copy/paste required
//
//  How it works:
//    • Each user has a persistent Peer ID stored in localStorage.
//    • They share their ID with a friend once (like a phone number).
//    • After that, calling is one click — PeerJS handles the SDP exchange
//      automatically through its free signaling relay (0.peerjs.com).
//    • Audio travels P2P (WebRTC), not through the relay.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Storage keys ────────────────────────────────────────────────────────────
const KEY_ID       = 'vcall_peer_id';
const KEY_CONTACTS = 'vcall_contacts';   // JSON: [{id, name, lastCall}]

// ─── State ───────────────────────────────────────────────────────────────────
let peer          = null;   // PeerJS Peer instance
let activeCall    = null;   // PeerJS MediaConnection
let localStream   = null;   // raw MediaStream from getUserMedia (mute control)
let audioCtx      = null;   // AudioContext for RNNoise pipeline
let isMuted       = false;
let callTimerID   = null;
let callSeconds   = 0;
let callTimeout   = null;   // auto-cancel timer for unanswered outgoing calls
let reconnectTarget   = null;  // {peerId, peerName} — who to call back on an unexpected drop
let reconnectAttempts = 0;     // how many auto-reconnect tries we've made so far
let reconnectTimer    = null;  // setTimeout handle for the next reconnect attempt
let intentionalHangup = false; // set true when the user deliberately ends the call
let ringtoneCtx    = null;   // AudioContext used exclusively for ringtone playback
let ringtoneTimer  = null;   // setInterval handle for repeating the ring
let ringtoneActive = false;  // guard so we never double-start
const _originalTitle = document.title; // saved so we can restore it after ringing

const MAX_RECONNECT    = 3;
const RECONNECT_DELAYS = [2000, 4000, 8000]; // ms — gentle back-off

// ─── Ringtone (Web Audio API — calm chime, works while app is minimised) ──────
function startRingtone() {
  if (ringtoneActive) return;
  ringtoneActive = true;
  document.title = 'Incoming call…';

  function ringOnce() {
    if (!ringtoneActive) return;
    // Create a fresh context every ring so Safari / Tauri WebView stays happy
    ringtoneCtx = new AudioContext();
    const ctx = ringtoneCtx;
    const now = ctx.currentTime;

    // A gentle three-note chime: C5 → E5 → G5
    const notes = [
      { freq: 523.25, t: 0.00 },   // C5
      { freq: 659.25, t: 0.18 },   // E5
      { freq: 783.99, t: 0.36 },   // G5
    ];

    notes.forEach(({ freq, t }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type            = 'sine';
      osc.frequency.value = freq;
      // Soft attack then smooth decay
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.25, now + t + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.55);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + t);
      osc.stop(now + t + 0.6);
    });

    // Repeat the chime every 2.2 seconds
    ringtoneTimer = setTimeout(() => {
      if (ringtoneCtx) { try { ringtoneCtx.close(); } catch (_) {} ringtoneCtx = null; }
      ringOnce();
    }, 2200);
  }

  ringOnce();
}

function stopRingtone() {
  ringtoneActive = false;
  clearTimeout(ringtoneTimer);
  ringtoneTimer = null;
  if (ringtoneCtx) {
    try { ringtoneCtx.close(); } catch (_) {}
    ringtoneCtx = null;
  }
  document.title = _originalTitle;
}

// ─── Contact Book (localStorage) ─────────────────────────────────────────────
function loadContacts() {
  try { return JSON.parse(localStorage.getItem(KEY_CONTACTS) || '[]'); }
  catch { return []; }
}
function saveContacts(list) {
  localStorage.setItem(KEY_CONTACTS, JSON.stringify(list));
}
function addOrUpdateContact(name, id) {
  const list = loadContacts().filter(c => c.id !== id);
  list.unshift({ id, name, lastCall: null });
  saveContacts(list);
}
function removeContact(id) {
  saveContacts(loadContacts().filter(c => c.id !== id));
}
function touchLastCall(id) {
  const list = loadContacts();
  const c = list.find(c => c.id === id);
  if (c) { c.lastCall = Date.now(); saveContacts(list); }
}
function getContactName(id) {
  const c = loadContacts().find(c => c.id === id);
  return c ? c.name : id.slice(0, 10) + '…';
}

// ─── UI helpers ──────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

let toastTimer = null;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 8000 : 2500);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000)     return 'just now';
  if (diff < 3_600_000)  return Math.floor(diff / 60_000)   + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

// ─── Contacts list render ─────────────────────────────────────────────────────
function renderContacts() {
  const list = loadContacts();
  const el   = document.getElementById('contacts-list');

  if (list.length === 0) {
    el.innerHTML = `
      <div class="contacts-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <p>No contacts yet.</p>
        <p class="contacts-empty-sub">Click <strong>+ Add Contact</strong> and paste your friend's Peer ID.</p>
      </div>`;
    return;
  }

  el.innerHTML = list.map(c => `
    <div class="contact-row" data-id="${escHtml(c.id)}">
      <div class="contact-avatar">${escHtml(c.name[0].toUpperCase())}</div>
      <div class="contact-info">
        <span class="contact-name">${escHtml(c.name)}</span>
        <span class="contact-sub">${c.lastCall ? relativeTime(c.lastCall) : 'Never called'}</span>
      </div>
      <div class="contact-actions">
        <button class="btn btn-primary btn-sm btn-call"
                data-id="${escHtml(c.id)}"
                data-name="${escHtml(c.name)}">Call</button>
        <button class="btn btn-ghost btn-sm btn-del"
                data-id="${escHtml(c.id)}" title="Remove contact">&#10005;</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('.btn-call').forEach(btn =>
    btn.addEventListener('click', () => startCall(btn.dataset.id, btn.dataset.name)));

  el.querySelectorAll('.btn-del').forEach(btn =>
    btn.addEventListener('click', () => {
      removeContact(btn.dataset.id);
      renderContacts();
    }));
}

// ─── PeerJS initialization ───────────────────────────────────────────────────
function initPeer() {
  const savedId = localStorage.getItem(KEY_ID) || undefined;
  peer = new Peer(savedId, {
    // PeerJS free cloud server — only used for the initial handshake (~2 KB/call)
    // Audio travels directly P2P after that.
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]
    }
  });

  peer.on('open', (id) => {
    localStorage.setItem(KEY_ID, id);
    const el = document.getElementById('my-peer-id');
    el.textContent = id;
    el.title = id;
  });

  // Someone is calling us
  peer.on('call', (incomingCall) => {
    // Auto-accept a reconnect call from the peer we were just talking to
    if (reconnectTarget && incomingCall.peer === reconnectTarget.peerId) {
      clearTimeout(reconnectTimer); reconnectTimer = null;
      if (activeCall) { try { activeCall.close(); } catch (_) {} activeCall = null; }
      activeCall = incomingCall;
      cleanupCallResources();
      acceptReconnectCall(incomingCall, reconnectTarget.peerName);
      return;
    }
    // If already in a call, decline gracefully
    if (activeCall) {
      incomingCall.close();
      return;
    }
    activeCall = incomingCall;
    const callerName = getContactName(incomingCall.peer);
    document.getElementById('incoming-caller-name').textContent = callerName;
    showScreen('screen-incoming');
    startRingtone();
  });

  peer.on('error', (err) => {
    const msg = err.type === 'peer-unavailable'
      ? 'Friend is offline or ID is wrong.'
      : 'Network error: ' + (err.message || err.type);
    showToast(msg, true);
    cleanup();
    renderContacts();
    showScreen('screen-idle');
  });

  peer.on('disconnected', () => {
    // Auto-reconnect to signaling server (needed to keep receiving calls)
    setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 2000);
  });
}

// ─── RNNoise noise cancellation pipeline ─────────────────────────────────────
/**
 * Wraps a raw mic MediaStream through an RNNoise AudioWorklet.
 * Returns a new MediaStream whose audio has background noise removed.
 * Falls back to the raw stream if anything goes wrong.
 */
async function buildNoiseCancelledStream(rawStream) {
  // 48 kHz — RNNoise is exclusively trained at this sample rate
  audioCtx = new AudioContext({ sampleRate: 48000 });

  // Register the worklet (same-origin, no bundler needed)
  await audioCtx.audioWorklet.addModule('./noise-worklet.js');

  // Fetch the WASM binary as a transferable ArrayBuffer
  const wasmResp   = await fetch('./assets/rnnoise.wasm');
  const wasmBinary = await wasmResp.arrayBuffer();

  // Build graph:  mic source → RNNoise worklet → MediaStream destination
  const source      = audioCtx.createMediaStreamSource(rawStream);
  const workletNode = new AudioWorkletNode(audioCtx, 'rnnoise-processor');
  const dest        = audioCtx.createMediaStreamDestination();

  source.connect(workletNode);
  workletNode.connect(dest);

  // Send WASM buffer to the worklet thread (transferred, not copied)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('RNNoise init timeout')), 5000);
    workletNode.port.onmessage = ({ data }) => {
      if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
      if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
    };
    workletNode.port.postMessage({ type: 'init', wasmBinary }, [wasmBinary]);
  });

  return dest.stream;
}

// ─── Mic error handler ───────────────────────────────────────────────────────
function handleMicError(e) {
  if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
    showToast(
      'Microphone access denied.\n' +
      'Fix: Windows Settings → Privacy → Microphone → enable for this app.',
      true
    );
  } else if (e.name === 'NotFoundError') {
    showToast('No microphone found. Plug one in and try again.', true);
  } else {
    showToast('Could not access microphone: ' + e.message, true);
  }
}

// ─── Call timer ──────────────────────────────────────────────────────────────
function startCallTimer() {
  callSeconds = 0;
  clearInterval(callTimerID);
  callTimerID = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('call-timer').textContent = m + ':' + s;
  }, 1000);
}
function stopCallTimer() { clearInterval(callTimerID); callTimerID = null; }

// ─── Cleanup ─────────────────────────────────────────────────────────────────
// Tears down mic / audio / call only. Safe to call mid-reconnect — does NOT
// wipe reconnect state so the retry loop can continue.
function cleanupCallResources() {
  stopCallTimer();
  clearTimeout(callTimeout); callTimeout = null;
  if (activeCall)  { activeCall.close();  activeCall  = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (audioCtx)    { audioCtx.close();    audioCtx    = null; }
  document.getElementById('remote-audio').srcObject = null;
  document.getElementById('call-timer').textContent = '00:00';
  isMuted     = false;
  callSeconds = 0;
  // Reset mute button state
  document.getElementById('icon-mic')?.classList.remove('hidden');
  document.getElementById('icon-mic-off')?.classList.add('hidden');
  document.getElementById('btn-mute')?.classList.remove('muted');
  const lbl = document.querySelector('#btn-mute + .btn-circle-label, #btn-mute ~ span');
  if (lbl) lbl.textContent = 'Mute';
}

// Full cleanup — also resets reconnect state. Use for intentional endings.
function cleanup() {
  cleanupCallResources();
  reconnectTarget   = null;
  reconnectAttempts = 0;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  intentionalHangup = false;
  clearReconnectUI();
}

// ─── Reconnect UI helpers ─────────────────────────────────────────────────────
function showReconnectUI(msg) {
  const overlay = document.getElementById('reconnect-overlay');
  const msgEl   = document.getElementById('reconnect-msg');
  if (overlay) overlay.classList.remove('hidden');
  if (msgEl)   msgEl.textContent = msg;
  const statusEl = document.querySelector('#screen-incall .call-status-text');
  if (statusEl)  statusEl.textContent = 'Reconnecting\u2026';
}

function clearReconnectUI() {
  const overlay = document.getElementById('reconnect-overlay');
  if (overlay)  overlay.classList.add('hidden');
  const statusEl = document.querySelector('#screen-incall .call-status-text');
  if (statusEl)  statusEl.textContent = 'Connected';
}

// ─── Auto-reconnect ───────────────────────────────────────────────────────────
function scheduleReconnect() {
  if (!reconnectTarget || reconnectAttempts >= MAX_RECONNECT) {
    const msg = reconnectAttempts >= MAX_RECONNECT
      ? 'Could not reconnect. Call again when ready.'
      : 'Connection lost.';
    showToast(msg, true);
    cleanup();
    renderContacts();
    showScreen('screen-idle');
    return;
  }

  const delay = RECONNECT_DELAYS[reconnectAttempts] ?? 8000;
  reconnectAttempts++;
  showReconnectUI(`Reconnecting\u2026 (${reconnectAttempts}/${MAX_RECONNECT})`);
  showScreen('screen-incall');

  reconnectTimer = setTimeout(async () => {
    if (!reconnectTarget) return; // was cancelled by an intentional hangup
    await startCall(reconnectTarget.peerId, reconnectTarget.peerName, true);
  }, delay);
}

// Accept a reconnect call that the remote peer initiated (they called back first)
async function acceptReconnectCall(call, peerName) {
  showReconnectUI('Reconnecting\u2026');
  showScreen('screen-incall');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, autoGainControl: true },
      video: false
    });
  } catch (e) {
    handleMicError(e);
    call.close(); activeCall = null;
    return;
  }
  let callStream = localStream;
  try {
    callStream = await buildNoiseCancelledStream(localStream);
  } catch (e) {
    console.warn('RNNoise init failed, using raw mic:', e);
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
  }
  call.answer(callStream);
  attachCallHandlers(call, peerName);
}

// ─── Attach handlers to an active call (outgoing OR incoming) ─────────────────
function attachCallHandlers(call, peerName) {
  // Guarantee unexpected-drop logic fires at most once per call object
  let dropHandled = false;
  function handleUnexpectedDrop() {
    if (dropHandled || intentionalHangup) return;
    dropHandled = true;
    if (activeCall === call) activeCall = null;
    cleanupCallResources();
    scheduleReconnect();
  }

  call.on('stream', (remoteStream) => {
    clearTimeout(callTimeout); callTimeout = null;
    // Record who we're talking to so we can reconnect automatically
    reconnectTarget   = { peerId: call.peer, peerName };
    reconnectAttempts = 0;
    clearReconnectUI();
    document.getElementById('remote-audio').srcObject = remoteStream;
    document.getElementById('incall-peer-name').textContent = peerName;
    touchLastCall(call.peer);
    renderContacts();
    startCallTimer();
    showScreen('screen-incall');
  });

  // Monitor WebRTC ICE state — detects silent mid-call drops (e.g. gaming Wi-Fi blip)
  const pc = call.peerConnection;
  if (pc) {
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'disconnected') {
        // WebRTC may self-heal; show a soft warning and wait
        showReconnectUI('Connection unstable\u2026');
      } else if (s === 'failed') {
        handleUnexpectedDrop();
      } else if (s === 'connected' || s === 'completed') {
        if (!dropHandled) { clearReconnectUI(); reconnectAttempts = 0; }
      }
    };
  }

  call.on('close', () => {
    if (intentionalHangup) {
      const wasConnected = document.getElementById('screen-incall').classList.contains('active');
      cleanup();
      renderContacts();
      showScreen('screen-idle');
      if (wasConnected) showToast('Call ended.');
    } else {
      handleUnexpectedDrop();
    }
  });

  call.on('error', () => {
    handleUnexpectedDrop();
  });
}

// ─── Outgoing call ───────────────────────────────────────────────────────────
async function startCall(peerId, peerName, isReconnect = false) {
  if (!peer || peer.disconnected) {
    showToast('Reconnecting to network…', true);
    peer.reconnect();
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, autoGainControl: true },
      video: false
    });
  } catch (e) {
    handleMicError(e);
    return;
  }

  // Run RNNoise; fall back to raw mic if WASM fails
  let callStream = localStream;
  try {
    callStream = await buildNoiseCancelledStream(localStream);
  } catch (e) {
    console.warn('RNNoise init failed, using raw mic:', e);
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
  }

  if (isReconnect) {
    // Stay on the in-call screen — the reconnecting overlay is already visible
    showReconnectUI(`Reconnecting\u2026 (${reconnectAttempts}/${MAX_RECONNECT})`);
    showScreen('screen-incall');
  } else {
    document.getElementById('calling-peer-name').textContent = peerName;
    const avatar = document.getElementById('calling-avatar');
    if (avatar) avatar.textContent = peerName[0]?.toUpperCase() || '?';
    showScreen('screen-calling');
  }

  const call = peer.call(peerId, callStream);
  activeCall  = call;

  // Auto-cancel unanswered outgoing calls (skip for reconnect attempts)
  if (!isReconnect) {
    callTimeout = setTimeout(() => {
      showToast('No answer.', true);
      cleanup();
      renderContacts();
      showScreen('screen-idle');
    }, 40_000);
  }

  attachCallHandlers(call, peerName);
}

// ─── Accept incoming call ────────────────────────────────────────────────────
async function acceptCall() {
  stopRingtone();
  if (!activeCall) return;
  const call     = activeCall;
  const peerName = document.getElementById('incoming-caller-name').textContent;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, autoGainControl: true },
      video: false
    });
  } catch (e) {
    handleMicError(e);
    call.close();
    activeCall = null;
    showScreen('screen-idle');
    return;
  }

  // Run RNNoise; fall back to raw mic if WASM fails
  let callStream = localStream;
  try {
    callStream = await buildNoiseCancelledStream(localStream);
  } catch (e) {
    console.warn('RNNoise init failed, using raw mic:', e);
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
  }

  call.answer(callStream);
  attachCallHandlers(call, peerName);
}

// ─── Reject / cancel ─────────────────────────────────────────────────────────
function rejectCall() {
  stopRingtone();
  intentionalHangup = true;
  if (activeCall) { activeCall.close(); activeCall = null; }
  cleanup();
  showScreen('screen-idle');
}

function cancelCall() {
  intentionalHangup = true;
  cleanup();
  showScreen('screen-idle');
}

// ─── In-call: mute ───────────────────────────────────────────────────────────
function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  document.getElementById('icon-mic').classList.toggle('hidden', isMuted);
  document.getElementById('icon-mic-off').classList.toggle('hidden', !isMuted);
  document.getElementById('btn-mute').classList.toggle('muted', isMuted);
}

// ─── In-call: hang up ────────────────────────────────────────────────────────
function hangUp() {
  intentionalHangup = true;
  cleanup();
  renderContacts();
  showScreen('screen-idle');
}

// ─── Copy my Peer ID ────────────────────────────────────────────────────────
async function copyMyId() {
  const id  = localStorage.getItem(KEY_ID);
  const btn = document.getElementById('btn-copy-my-id');
  if (!id) { showToast('ID not ready yet.', true); return; }
  try {
    await navigator.clipboard.writeText(id);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  } catch {
    showToast('Could not copy to clipboard.', true);
  }
}

// ─── Save a new contact ───────────────────────────────────────────────────────
function saveContact() {
  const name = document.getElementById('contact-name-input').value.trim();
  const id   = document.getElementById('contact-id-input').value.trim();
  if (!name) { showToast('Enter a name.', true); return; }
  if (!id)   { showToast("Paste your friend's Peer ID.", true); return; }
  if (id === localStorage.getItem(KEY_ID)) {
    showToast("That's your own ID!", true); return;
  }
  addOrUpdateContact(name, id);
  document.getElementById('contact-name-input').value = '';
  document.getElementById('contact-id-input').value   = '';
  renderContacts();
  showScreen('screen-idle');
  showToast(name + ' added to contacts.');
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initPeer();
  renderContacts();

  // Home
  document.getElementById('btn-copy-my-id')
    .addEventListener('click', copyMyId);
  document.getElementById('btn-add-contact')
    .addEventListener('click', () => showScreen('screen-add-contact'));

  // Add Contact screen
  document.getElementById('btn-back-add')
    .addEventListener('click', () => showScreen('screen-idle'));
  document.getElementById('btn-save-contact')
    .addEventListener('click', saveContact);
  document.getElementById('contact-name-input')
    .addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('contact-id-input').focus(); });
  document.getElementById('contact-id-input')
    .addEventListener('keydown', e => { if (e.key === 'Enter') saveContact(); });

  // Incoming call screen
  document.getElementById('btn-accept')
    .addEventListener('click', acceptCall);
  document.getElementById('btn-reject')
    .addEventListener('click', rejectCall);

  // Calling (outgoing) screen
  document.getElementById('btn-cancel-call')
    .addEventListener('click', cancelCall);

  // In-call screen
  document.getElementById('btn-mute')
    .addEventListener('click', toggleMute);
  document.getElementById('btn-hangup')
    .addEventListener('click', hangUp);
});
