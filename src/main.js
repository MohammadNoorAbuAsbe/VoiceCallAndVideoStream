// ─────────────────────────────────────────────────────────────────────────────
//  VoiceCall — relay-based, no ICE / TURN / WebRTC.
//
//  Clients open an outbound WebSocket to a relay server (which you host). The
//  relay forwards call signaling and raw audio PCM frames between the two
//  peers. Because only outbound WebSocket connections are used, calls work
//  behind any NAT / firewall with no NAT-traversal setup.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Storage keys ────────────────────────────────────────────────────────────
const KEY_ID            = 'vcall_peer_id';
const KEY_CONTACTS      = 'vcall_contacts';
const KEY_MIC_DEVICE    = 'vcall_mic_device';
const KEY_OUTPUT_DEVICE = 'vcall_out_device';
const KEY_MUTE_KEYBIND  = 'vcall_mute_key';
const KEY_RELAY_URL     = 'vcall_relay_url';
const KEY_RELAY_TOKEN   = 'vcall_relay_token';

// Bake your deployed wss:// URL here so users never have to set it.
const DEFAULT_RELAY_URL = 'wss://voicecallandvideostream.onrender.com';

// ─── State ───────────────────────────────────────────────────────────────────
import { RelayClient } from './relay.js';
import * as audio from './audio.js';

let relay        = null;
let myId         = null;
let myName       = 'Me';

let activeCall        = null; // { callId, peerId, peerName, direction }
let pendingOutgoing   = null; // { callId, to, name }
let pendingIncoming   = null; // { callId, from, name }
let intentionalHangup = false;
let reconnecting      = false;
let noAnswerTimer     = null;
let selfReconnectTimer= null;
let callConnectedAt   = 0;
let lastAudioAt       = 0;

let isMuted                   = false;
let noiseCancellationEnabled  = true;

let callTimerID = null;
let callSeconds = 0;

const _originalTitle = document.title;

// ─── Ringtone ─────────────────────────────────────────────────────────────────
function startRingtone() {
  if (ringtoneActive) return;
  ringtoneActive = true;
  document.title = 'Incoming call…';
  function ringOnce() {
    if (!ringtoneActive) return;
    ringtoneCtx = new AudioContext();
    const ctx = ringtoneCtx;
    const now = ctx.currentTime;
    const notes = [
      { freq: 523.25, t: 0.00 },
      { freq: 659.25, t: 0.18 },
      { freq: 783.99, t: 0.36 },
    ];
    notes.forEach(({ freq, t }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type            = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.25, now + t + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.55);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + t); osc.stop(now + t + 0.6);
    });
    ringtoneTimer = setTimeout(() => {
      if (ringtoneCtx) { try { ringtoneCtx.close(); } catch (_) {} ringtoneCtx = null; }
      ringOnce();
    }, 2200);
  }
  ringOnce();
}
let ringtoneCtx = null, ringtoneTimer = null, ringtoneActive = false;
function stopRingtone() {
  ringtoneActive = false;
  clearTimeout(ringtoneTimer); ringtoneTimer = null;
  if (ringtoneCtx) { try { ringtoneCtx.close(); } catch (_) {} ringtoneCtx = null; }
  document.title = _originalTitle;
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
function loadContacts() {
  try { return JSON.parse(localStorage.getItem(KEY_CONTACTS) || '[]'); }
  catch { return []; }
}
function saveContacts(list) { localStorage.setItem(KEY_CONTACTS, JSON.stringify(list)); }
function addOrUpdateContact(name, id) {
  const list = loadContacts().filter(c => c.id !== id);
  list.unshift({ id, name, lastCall: null });
  saveContacts(list);
}
function removeContact(id) { saveContacts(loadContacts().filter(c => c.id !== id)); }
function touchLastCall(id) {
  const list = loadContacts();
  const c = list.find(c => c.id === id);
  if (c) { c.lastCall = Date.now(); saveContacts(list); }
}
function getContactName(id) {
  const c = loadContacts().find(c => c.id === id);
  return c ? c.name : id.slice(0, 10) + '…';
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
let toastTimer = null;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
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
        <p class="contacts-empty-sub">Click <strong>+ Add Contact</strong> and paste your friend's ID.</p>
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
        <button class="btn btn-primary btn-sm btn-call" data-id="${escHtml(c.id)}" data-name="${escHtml(c.name)}">Call</button>
        <button class="btn btn-ghost btn-sm btn-del" data-id="${escHtml(c.id)}" title="Remove contact">&#10005;</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('.btn-call').forEach(btn =>
    btn.addEventListener('click', () => startCall(btn.dataset.id, btn.dataset.name)));
  el.querySelectorAll('.btn-del').forEach(btn =>
    btn.addEventListener('click', () => { removeContact(btn.dataset.id); renderContacts(); }));
}

// ─── Relay status indicator ───────────────────────────────────────────────────
function setRelayStatus(connected, text) {
  const el = document.getElementById('relay-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'relay-status ' + (connected ? 'online' : 'offline');
}

// ─── Relay connection ─────────────────────────────────────────────────────────
function getRelayUrl()   { return localStorage.getItem(KEY_RELAY_URL)   || DEFAULT_RELAY_URL || ''; }
function getRelayToken() { return localStorage.getItem(KEY_RELAY_TOKEN) || ''; }
function getMicDeviceId()    { return localStorage.getItem(KEY_MIC_DEVICE)    || ''; }
function getOutputDeviceId() { return localStorage.getItem(KEY_OUTPUT_DEVICE) || ''; }

function generateId()    { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function generateCallId(){ return Math.random().toString(36).slice(2, 12); }

function loadOrCreateId() {
  let id = localStorage.getItem(KEY_ID);
  if (!id) { id = generateId(); localStorage.setItem(KEY_ID, id); }
  return id;
}

function initRelay() {
  const url = getRelayUrl();
  if (!url) {
    setRelayStatus(false, 'Relay URL not set');
    document.getElementById('my-peer-id').textContent = myId;
    return;
  }
  relay = new RelayClient(url);
  relay
    .on('open',      () => setRelayStatus(true, 'Connected'))
    .on('registered',() => {
      setRelayStatus(true, 'Connected');
      // If we dropped mid-call, re-bind the call now that we're back.
      if (activeCall) { reconnecting = true; showReconnectUI('Reconnecting…'); relay.reconnect(activeCall.callId, activeCall.peerId); }
    })
    .on('id-taken',  () => {
      myId = generateId();
      localStorage.setItem(KEY_ID, myId);
      document.getElementById('my-peer-id').textContent = myId;
      relay.connect(myId, getRelayToken());
    })
    .on('close',     () => {
      setRelayStatus(false, 'Reconnecting…');
      if (activeCall) { reconnecting = true; showReconnectUI('Reconnecting…'); }
    })
    .on('audio',     (bytes) => {
      audio.playBytes(bytes.buffer);
      lastAudioAt = Date.now();
      if (reconnecting) { reconnecting = false; clearReconnectUI(); }
    })
    .on('incoming',  (m) => handleIncoming(m))
    .on('accepted',  (m) => handleAccepted(m))
    .on('rejected',  (m) => handleRejected(m))
    .on('cancelled', (m) => handleCancelled(m))
    .on('ended',     (m) => handleEnded(m))
    .on('busy',      (m) => handleBusy(m))
    .on('peer-unavailable', (m) => handleUnavailable(m))
    .on('reconnecting', (m) => handlePeerReconnecting(m))
    .on('reconnected',  (m) => handleReconnected(m))
    .on('muted',     (m) => handleRemoteMuted(m));

  relay.connect(myId, getRelayToken());
}

// ─── Incoming call ─────────────────────────────────────────────────────────────
function handleIncoming(m) {
  const { from, name, callId } = m;

  // Glare: we're also calling them. Higher id wins and keeps its outgoing call.
  if (pendingOutgoing && pendingOutgoing.to === from) {
    if (myId > from) return; // we win — ignore their incoming, wait for 'accepted'
    // We lose — cancel our outgoing and auto-answer theirs.
    relay.cancel(pendingOutgoing.callId, from);
    pendingOutgoing = null;
    acceptIncomingInternal(callId, from, getContactName(from), true);
    return;
  }
  if (activeCall || pendingIncoming) { relay.reject(callId, from); return; }

  pendingIncoming = { callId, from, name };
  document.getElementById('incoming-caller-name').textContent = getContactName(from);
  showScreen('screen-incoming');
  startRingtone();
}

async function acceptCall() {
  if (!pendingIncoming) return;
  stopRingtone();
  await acceptIncomingInternal(pendingIncoming.callId, pendingIncoming.from, getContactName(pendingIncoming.from), false);
}
async function acceptIncomingInternal(callId, from, peerName, auto) {
  try { await audio.initCapture(getMicDeviceId(), noiseCancellationEnabled); }
  catch (e) {
    handleMicError(e); // we still connect so we can hear them; we just can't talk
    showToast('Mic unavailable — you can listen but not speak.', true);
  }
  relay.accept(callId, from);
  activeCall = { callId, peerId: from, peerName, direction: 'in' };
  pendingIncoming = null;
  callConnectedAt = Date.now();
  document.getElementById('incall-peer-name').textContent = peerName;
  showScreen('screen-incall');
  startCallTimer();
  touchLastCall(from);
  renderContacts();
  ensureAudioPlaying();
}

function rejectCall() {
  stopRingtone();
  if (pendingIncoming) relay.reject(pendingIncoming.callId, pendingIncoming.from);
  pendingIncoming = null;
  showScreen('screen-idle');
}

// ─── Outgoing call ─────────────────────────────────────────────────────────────
async function startCall(peerId, peerName) {
  if (!getRelayUrl()) {
    showToast('Set the Relay Server URL in Settings first.', true);
    showScreen('screen-settings');
    return;
  }
  if (!relay || !relay.connected) { showToast('Connecting to relay…', true); return; }
  if (activeCall || pendingOutgoing || pendingIncoming) { showToast('You are already in a call.', true); return; }

  try { await audio.initCapture(getMicDeviceId(), noiseCancellationEnabled); }
  catch (e) { handleMicError(e); return; }

  const callId = generateCallId();
  pendingOutgoing = { callId, to: peerId, name: peerName };
  document.getElementById('calling-peer-name').textContent = peerName;
  const avatar = document.getElementById('calling-avatar');
  if (avatar) avatar.textContent = peerName[0]?.toUpperCase() || '?';
  showScreen('screen-calling');
  ensureAudioPlaying(); // create/resume playback context during the click gesture

  relay.call(peerId, myId, callId);
  noAnswerTimer = setTimeout(() => {
    if (pendingOutgoing && pendingOutgoing.callId === callId) {
      const t = pendingOutgoing.to;
      pendingOutgoing = null;
      audio.closeCapture();
      relay.cancel(callId, t);
      showToast('No answer.', true);
      showScreen('screen-idle');
    }
  }, 40000);
}

function cancelCall() {
  if (!pendingOutgoing) return;
  const { callId, to } = pendingOutgoing;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  pendingOutgoing = null;
  audio.closeCapture();
  relay.cancel(callId, to);
  showScreen('screen-idle');
}

// ─── Call accepted by the other side ───────────────────────────────────────────
function handleAccepted(m) {
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  activeCall = { callId: pendingOutgoing.callId, peerId: pendingOutgoing.to, peerName: pendingOutgoing.name, direction: 'out' };
  pendingOutgoing = null;
  callConnectedAt = Date.now();
  document.getElementById('incall-peer-name').textContent = activeCall.peerName;
  showScreen('screen-incall');
  startCallTimer();
  touchLastCall(activeCall.peerId);
  renderContacts();
  ensureAudioPlaying();
}
function handleRejected(m) {
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  pendingOutgoing = null;
  audio.closeCapture();
  showToast('Call declined.');
  showScreen('screen-idle');
}
function handleCancelled(m) {
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  pendingOutgoing = null;
  audio.closeCapture();
  showToast('Call cancelled.');
  showScreen('screen-idle');
}
function handleBusy(m) {
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  pendingOutgoing = null;
  audio.closeCapture();
  showToast('Friend is busy.', true);
  showScreen('screen-idle');
}
function handleUnavailable(m) {
  if (activeCall && activeCall.callId === m.callId) {
    endCallCleanup('Connection lost.');
    return;
  }
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  pendingOutgoing = null;
  audio.closeCapture();
  showToast('Friend is offline.', true);
  showScreen('screen-idle');
}

// ─── Call ended ─────────────────────────────────────────────────────────────────
function handleEnded(m) {
  if (activeCall && activeCall.callId === m.callId) {
    if (intentionalHangup) endCallCleanup();
    else endCallCleanup('Call ended.');
  } else if (pendingIncoming && pendingIncoming.callId === m.callId) {
    stopRingtone();
    pendingIncoming = null;
    showScreen('screen-idle');
  }
}

// ─── Reconnect (peer dropped) ───────────────────────────────────────────────────
function handlePeerReconnecting(m) {
  if (!activeCall || activeCall.callId !== m.callId) return;
  reconnecting = true;
  showReconnectUI('Reconnecting…');
  clearTimeout(selfReconnectTimer);
  selfReconnectTimer = setTimeout(() => {
    if (activeCall && relay.connected) relay.reconnect(activeCall.callId, activeCall.peerId);
  }, 1500);
}
function handleReconnected(m) {
  if (!activeCall || activeCall.callId !== m.callId) return;
  reconnecting = false;
  clearReconnectUI();
  ensureAudioPlaying();
}

// ─── Hang up / cleanup ──────────────────────────────────────────────────────────
function hangUp() {
  intentionalHangup = true;
  if (activeCall) relay.hangup(activeCall.callId, activeCall.peerId);
  endCallCleanup();
}
function endCallCleanup(msg) {
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  clearTimeout(selfReconnectTimer); selfReconnectTimer = null;
  stopCallTimer();
  audio.closeCapture();
  activeCall = null;
  pendingOutgoing = null;
  pendingIncoming = null;
  reconnecting = false;
  intentionalHangup = false;
  clearReconnectUI();
  resetInCallButtons();
  showScreen('screen-idle');
  if (msg) showToast(msg);
}

// ─── Remote mute indicator ─────────────────────────────────────────────────────
function handleRemoteMuted(m) {
  if (!activeCall || activeCall.peerId !== m.from) return;
  const el = document.getElementById('incall-remote-mute');
  if (el) el.textContent = m.muted ? 'Muted' : '';
}

// ─── Reconnect UI ───────────────────────────────────────────────────────────────
function showReconnectUI(msg) {
  const overlay = document.getElementById('reconnect-overlay');
  const msgEl   = document.getElementById('reconnect-msg');
  if (overlay) overlay.classList.remove('hidden');
  if (msgEl)   msgEl.textContent = msg;
  const statusEl = document.querySelector('#screen-incall .call-status-text');
  if (statusEl) statusEl.textContent = 'Reconnecting…';
}
function clearReconnectUI() {
  const overlay = document.getElementById('reconnect-overlay');
  if (overlay) overlay.classList.add('hidden');
  const statusEl = document.querySelector('#screen-incall .call-status-text');
  if (statusEl) statusEl.textContent = 'Connected';
}

// ─── In-call: mute / noise cancel / audio playback ──────────────────────────────
function toggleMute() {
  if (!activeCall) return;
  isMuted = !isMuted;
  audio.setMuted(isMuted);
  if (activeCall) relay.sendMute(activeCall.peerId, isMuted);
  document.getElementById('icon-mic').classList.toggle('hidden', isMuted);
  document.getElementById('icon-mic-off').classList.toggle('hidden', !isMuted);
  document.getElementById('btn-mute').classList.toggle('muted', isMuted);
}
function toggleNoiseCancellation() {
  noiseCancellationEnabled = !noiseCancellationEnabled;
  audio.setNoiseCancel(noiseCancellationEnabled);
  document.getElementById('btn-noise-cancel').classList.toggle('nc-off', !noiseCancellationEnabled);
  showToast(noiseCancellationEnabled ? 'Noise cancellation on.' : 'Noise cancellation off.');
}
function resetInCallButtons() {
  isMuted = false;
  document.getElementById('icon-mic').classList.remove('hidden');
  document.getElementById('icon-mic-off').classList.add('hidden');
  document.getElementById('btn-mute').classList.remove('muted');
  document.getElementById('call-timer').textContent = '00:00';
  const rm = document.getElementById('incall-remote-mute');
  if (rm) rm.textContent = '';
}

async function ensureAudioPlaying() {
  try {
    if (!audio.isPlaybackReady()) await audio.initPlayback();
    else await audio.resumePlayback();
    const el = document.getElementById('remote-audio');
    if (el) el.play().catch(() => {});
    if (audio.isPlaybackSuspended()) showEnableSound(); else hideEnableSound();
  } catch (e) { console.warn('audio playback init failed:', e); }
}
function showEnableSound() {
  const b = document.getElementById('btn-enable-sound');
  if (b) b.classList.remove('hidden');
}
function hideEnableSound() {
  const b = document.getElementById('btn-enable-sound');
  if (b) b.classList.add('hidden');
}
async function enableSoundTapped() {
  await audio.resumePlayback();
  const el = document.getElementById('remote-audio');
  if (el) el.play().catch(() => {});
  hideEnableSound();
}

// ─── Call timer ─────────────────────────────────────────────────────────────────
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

// ─── Mic error handler ───────────────────────────────────────────────────────────
function handleMicError(e) {
  if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
    showToast('Microphone access denied.\nWindows Settings → Privacy → Microphone → enable for this app.', true);
  } else if (e.name === 'NotFoundError') {
    showToast('No microphone found. Plug one in and try again.', true);
  } else {
    showToast('Could not access microphone: ' + e.message, true);
  }
}

// ─── Device settings ─────────────────────────────────────────────────────────────
async function populateDeviceSelects() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach(t => t.stop());
  } catch (_) { /* labels may be empty */ }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics    = devices.filter(d => d.kind === 'audioinput');
  const outputs = devices.filter(d => d.kind === 'audiooutput');
  const micSelect    = document.getElementById('select-mic');
  const outputSelect = document.getElementById('select-output');
  const savedMic     = getMicDeviceId();
  const savedOutput  = getOutputDeviceId();

  micSelect.innerHTML = (mics.length ? mics : []).map((d, i) =>
    `<option value="${escHtml(d.deviceId)}" ${d.deviceId === savedMic ? 'selected' : ''}>${escHtml(d.label || 'Microphone ' + (i + 1))}</option>`
  ).join('');
  if (!mics.length) micSelect.innerHTML = '<option value="">No microphones found</option>';

  outputSelect.innerHTML = (outputs.length ? outputs : []).map((d, i) =>
    `<option value="${escHtml(d.deviceId)}" ${d.deviceId === savedOutput ? 'selected' : ''}>${escHtml(d.label || 'Speaker ' + (i + 1))}</option>`
  ).join('');
  if (!outputs.length) outputSelect.innerHTML = '<option value="">No output devices found</option>';
}
async function applyOutputDevice() {
  const deviceId = getOutputDeviceId();
  if (deviceId) await audio.setOutputDevice(deviceId);
}

// ─── Mute keybind ─────────────────────────────────────────────────────────────────
function getMuteKeybind() {
  try { return JSON.parse(localStorage.getItem(KEY_MUTE_KEYBIND) || 'null'); }
  catch { return null; }
}
function setMuteKeybind(kb) {
  if (kb) localStorage.setItem(KEY_MUTE_KEYBIND, JSON.stringify(kb));
  else    localStorage.removeItem(KEY_MUTE_KEYBIND);
}
const _codeLabels = {
  Space:'Space', Backquote:'`', Minus:'-', Equal:'=', BracketLeft:'[', BracketRight:']',
  Backslash:'\\', Semicolon:';', Quote:"'", Comma:',', Period:'.', Slash:'/',
  Backspace:'Backspace', Tab:'Tab', CapsLock:'Caps', Enter:'Enter', Escape:'Esc',
  Delete:'Del', Insert:'Ins', Home:'Home', End:'End', PageUp:'PgUp', PageDown:'PgDn',
  ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→',
  PrintScreen:'PrtSc', ScrollLock:'ScrLk', Pause:'Pause', NumLock:'NumLk',
};
for (let i = 1; i <= 12; i++) _codeLabels['F' + i] = 'F' + i;
for (let i = 0; i <= 9; i++)  _codeLabels['Digit' + i] = String(i);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') _codeLabels['Key' + c] = c;
function formatKeybind(kb) {
  if (!kb) return 'None';
  const parts = [];
  if (kb.ctrl)  parts.push('Ctrl');
  if (kb.shift) parts.push('Shift');
  if (kb.alt)   parts.push('Alt');
  if (kb.meta)  parts.push('Meta');
  parts.push(_codeLabels[kb.code] || kb.code);
  return parts.join('+');
}
function updateKeybindDisplay() {
  const el = document.getElementById('keybind-display');
  if (!el) return;
  el.textContent = formatKeybind(getMuteKeybind());
  el.classList.remove('listening');
}
let _keybindCapturing = false;
function startKeybindCapture() {
  if (_keybindCapturing) return;
  _keybindCapturing = true;
  const display = document.getElementById('keybind-display');
  const btn     = document.getElementById('btn-set-keybind');
  display.textContent = 'Press a key…';
  display.classList.add('listening');
  btn.textContent = 'Cancel';
  function onKey(e) {
    if (['Control','Shift','Alt','Meta'].includes(e.key)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    stopCapture();
    if (e.key === 'Escape') { updateKeybindDisplay(); return; }
    const kb = { code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
    setMuteKeybind(kb);
    updateKeybindDisplay();
    showToast('Keybind set to ' + formatKeybind(kb) + '.');
  }
  function stopCapture() {
    _keybindCapturing = false;
    document.removeEventListener('keydown', onKey, true);
    const b = document.getElementById('btn-set-keybind'); if (b) b.textContent = 'Set';
    const d = document.getElementById('keybind-display'); if (d) d.classList.remove('listening');
  }
  document.addEventListener('keydown', onKey, true);
}

// ─── Copy my ID ───────────────────────────────────────────────────────────────────
async function copyMyId() {
  if (!myId) { showToast('ID not ready yet.', true); return; }
  try {
    await navigator.clipboard.writeText(myId);
    const btn = document.getElementById('btn-copy-my-id');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  } catch { showToast('Could not copy to clipboard.', true); }
}

// ─── Save contact ─────────────────────────────────────────────────────────────────
function saveContact() {
  const name = document.getElementById('contact-name-input').value.trim();
  const id   = document.getElementById('contact-id-input').value.trim();
  if (!name) { showToast('Enter a name.', true); return; }
  if (!id)   { showToast("Paste your friend's ID.", true); return; }
  if (id === myId) { showToast("That's your own ID!", true); return; }
  addOrUpdateContact(name, id);
  document.getElementById('contact-name-input').value = '';
  document.getElementById('contact-id-input').value   = '';
  renderContacts();
  showScreen('screen-idle');
  showToast(name + ' added to contacts.');
}

// ─── Audio frame wiring ───────────────────────────────────────────────────────────
audio.setOnFrame((frame48) => {
  if (!activeCall || !relay || !relay.connected) return;
  relay.sendAudio(audio.capture48ToWire(frame48));
});
audio.setOnStarved((starved) => {
  if (!activeCall) return;
  const statusEl = document.querySelector('#screen-incall .call-status-text');
  if (!statusEl) return;
  if (starved && Date.now() - callConnectedAt > 2500 && !reconnecting) {
    statusEl.textContent = 'No audio from ' + activeCall.peerName;
  } else if (!reconnecting) {
    statusEl.textContent = 'Connected';
  }
});

// ─── Global mute keybind listener ───────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (_keybindCapturing) return;
  const kb = getMuteKeybind();
  if (!kb) return;
  if (e.code === kb.code && e.ctrlKey === kb.ctrl && e.shiftKey === kb.shift &&
      e.altKey === kb.alt && e.metaKey === kb.meta) {
    e.preventDefault();
    toggleMute();
    if (!document.getElementById('screen-incall')?.classList.contains('active')) {
      showToast(isMuted ? 'Mic muted.' : 'Mic unmuted.');
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  myId = loadOrCreateId();
  document.getElementById('my-peer-id').textContent = myId;
  initRelay();
  renderContacts();

  document.getElementById('btn-copy-my-id').addEventListener('click', copyMyId);
  document.getElementById('btn-add-contact').addEventListener('click', () => showScreen('screen-add-contact'));
  document.getElementById('btn-open-settings').addEventListener('click', () => {
    populateDeviceSelects(); updateKeybindDisplay();
    document.getElementById('relay-url-input').value = getRelayUrl();
    document.getElementById('relay-token-input').value = getRelayToken();
    showScreen('screen-settings');
  });

  document.getElementById('btn-back-settings').addEventListener('click', () => showScreen('screen-idle'));
  document.getElementById('btn-refresh-devices').addEventListener('click', () => populateDeviceSelects());
  document.getElementById('select-mic').addEventListener('change', e => localStorage.setItem(KEY_MIC_DEVICE, e.target.value));
  document.getElementById('select-output').addEventListener('change', async e => {
    localStorage.setItem(KEY_OUTPUT_DEVICE, e.target.value);
    await applyOutputDevice();
  });
  document.getElementById('btn-save-relay').addEventListener('click', () => {
    localStorage.setItem(KEY_RELAY_URL, document.getElementById('relay-url-input').value.trim());
    localStorage.setItem(KEY_RELAY_TOKEN, document.getElementById('relay-token-input').value.trim());
    showToast('Relay saved. Reconnecting…');
    // Tear down and rebuild the relay connection with the new URL.
    if (relay) { relay.connected = false; try { relay.ws && relay.ws.close(); } catch {} }
    initRelay();
  });
  document.getElementById('btn-set-keybind').addEventListener('click', () => {
    if (_keybindCapturing) {
      document.getElementById('btn-set-keybind').textContent = 'Set';
      document.getElementById('keybind-display').classList.remove('listening');
      _keybindCapturing = false;
      updateKeybindDisplay();
    } else { startKeybindCapture(); }
  });
  document.getElementById('btn-clear-keybind').addEventListener('click', () => {
    setMuteKeybind(null); updateKeybindDisplay(); showToast('Keybind cleared.');
  });

  document.getElementById('btn-back-add').addEventListener('click', () => showScreen('screen-idle'));
  document.getElementById('btn-save-contact').addEventListener('click', saveContact);
  document.getElementById('contact-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('contact-id-input').focus(); });
  document.getElementById('contact-id-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveContact(); });

  document.getElementById('btn-accept').addEventListener('click', acceptCall);
  document.getElementById('btn-reject').addEventListener('click', rejectCall);
  document.getElementById('btn-cancel-call').addEventListener('click', cancelCall);
  document.getElementById('btn-mute').addEventListener('click', toggleMute);
  document.getElementById('btn-noise-cancel').addEventListener('click', toggleNoiseCancellation);
  document.getElementById('btn-hangup').addEventListener('click', hangUp);
  document.getElementById('btn-enable-sound')?.addEventListener('click', enableSoundTapped);

  // Re-enumerate devices if they change (e.g. headset plugged in).
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (document.getElementById('screen-settings').classList.contains('active')) populateDeviceSelects();
  });
});
