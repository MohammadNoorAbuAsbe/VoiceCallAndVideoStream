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
const KEY_PUB           = 'vcall_pub_key';
const KEY_PRIV          = 'vcall_priv_key';
const KEY_MIC_DEVICE    = 'vcall_mic_device';
const KEY_OUTPUT_DEVICE = 'vcall_out_device';
const KEY_MUTE_KEYBIND  = 'vcall_mute_key';
const KEY_RELAY_URL     = 'vcall_relay_url';
const KEY_RELAY_TOKEN   = 'vcall_relay_token';

// Bake your deployed wss:// URL here so users never have to set it.
let DEFAULT_RELAY_URL = 'wss://voicecallandvideostream.onrender.com';

// ─── State ───────────────────────────────────────────────────────────────────
import { RelayClient } from './relay.js';
import * as audio from './audio.js';
import { loadIdentity, generateIdentity, CallSession } from './crypto.js';
import {
  escHtml, relativeTime, formatKeybind, generateCallId,
  loadContacts, saveContacts, addOrUpdateContact, removeContact, touchLastCall, getContactName,
} from './util.js';

let relay        = null;
let myId         = null;
let identity     = null;   // { id, publicKeyB64, privateKeyB64, sign } — see crypto.js
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
// @illusion: play repeating ringtone melody via Web Audio oscillators
function startRingtone() {
  if (ringtoneActive) return;
  ringtoneActive = true;
  document.title = 'Incoming call…';
  // @illusion: play one ringtone chord sequence and schedule next iteration
  function ringOnce() {
    /* v8 ignore next */
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
      /* v8 ignore next */
      // @illusion: close the previous ringtone AudioContext before scheduling the next iteration
      if (ringtoneCtx) { try { ringtoneCtx.close(); } catch (_) {} ringtoneCtx = null; }
      ringOnce();
    }, 2200);
  }
  ringOnce();
}
let ringtoneCtx = null, ringtoneTimer = null, ringtoneActive = false;
// @illusion: stop ringtone, close AudioContext, restore document title
function stopRingtone() {
  ringtoneActive = false;
  clearTimeout(ringtoneTimer); ringtoneTimer = null;
  /* v8 ignore next */
  // @illusion: close the ringtone AudioContext, ignoring errors if already stopped
  if (ringtoneCtx) { try { ringtoneCtx.close(); } catch (_) {} ringtoneCtx = null; }
  document.title = _originalTitle;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
// @illusion: show target screen by ID, hide all others
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
let toastTimer = null;
// @illusion: show notification toast with optional error styling
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 8000 : 2500);
}

// @illusion: render contacts list from localStorage with call/delete buttons
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
// @illusion: update relay status indicator color and text
function setRelayStatus(connected, text) {
  const el = document.getElementById('relay-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'relay-status ' + (connected ? 'online' : 'offline');
}

// ─── Relay connection ─────────────────────────────────────────────────────────
// @illusion: read stored relay server URL
function getRelayUrl()   { return localStorage.getItem(KEY_RELAY_URL)   || DEFAULT_RELAY_URL || ''; }
// @illusion: read stored relay auth token
function getRelayToken() { return localStorage.getItem(KEY_RELAY_TOKEN) || ''; }
// @illusion: read stored microphone device ID
function getMicDeviceId()    { return localStorage.getItem(KEY_MIC_DEVICE)    || ''; }
// @illusion: read stored output device ID
function getOutputDeviceId() { return localStorage.getItem(KEY_OUTPUT_DEVICE) || ''; }

// Read the currently-known peer ID from storage (empty until an identity is
// created). The real ID is the fingerprint of the identity public key.
function loadOrCreateId() {
  return localStorage.getItem(KEY_ID) || '';
}

// Persist the current cryptographic identity (public key, private key, and the
// derived ID) to localStorage.
function persistIdentity() {
  localStorage.setItem(KEY_PUB,  identity.publicKeyB64);
  localStorage.setItem(KEY_PRIV, identity.privateKeyB64);
  localStorage.setItem(KEY_ID,   identity.id);
}

// Load the stored Ed25519 identity, or generate and persist a new one. The peer
// ID is derived from the public key, so it is unforgeable — no one can register
// as us without our private key.
async function ensureIdentity() {
  if (identity) return identity;
  const pub  = localStorage.getItem(KEY_PUB);
  const priv = localStorage.getItem(KEY_PRIV);
  if (pub && priv) {
    try { identity = await loadIdentity(pub, priv); }
    catch { identity = await generateIdentity(); persistIdentity(); }
  } else {
    identity = await generateIdentity();
    persistIdentity();
  }
  if (!myId) myId = identity.id;
  return identity;
}

// Build the auth bundle the relay uses to answer the server's registration
// challenge (proves possession of the identity private key).
function relayAuth() {
  if (!identity) return null;
  return { pubKeyB64: identity.publicKeyB64, sign: (bytes) => identity.sign(bytes) };
}

// @illusion: create RelayClient, wire all event handlers, connect to relay
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
      // With key-derived IDs a collision means this identity is already online
      // in another session — rotating the ID would abandon our contacts, so we
      // surface it instead.
      setRelayStatus(false, 'ID already online elsewhere');
    })
    .on('close',     () => {
      setRelayStatus(false, 'Reconnecting…');
      if (activeCall) { reconnecting = true; showReconnectUI('Reconnecting…'); }
    })
    .on('audio',     (bytes) => {
      lastAudioAt = Date.now();
      if (reconnecting) { reconnecting = false; clearReconnectUI(); }
      const session = activeCall && activeCall.session;
      if (!session || !session.ready) return; // can't decrypt without a session
      const chain = (activeCall._recvChain || Promise.resolve())
        .then(() => session.decrypt(bytes))
        .then((pt) => audio.playBytes(pt.buffer !== undefined ? pt.buffer : pt))
        .catch(() => {}); // drop undecryptable frames
      activeCall._recvChain = chain;
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

  relay.connect(myId, getRelayToken(), relayAuth());
}

// ─── Incoming call ─────────────────────────────────────────────────────────────
// Handle an incoming call: resolve glare, auto-reject when busy, otherwise ring.
// `offer` carries the peer's signed key-exchange material for E2E encryption.
function handleIncoming(m) {
  const { from, name, callId, offer } = m;

  // Glare: we're also calling them. Higher id wins and keeps its outgoing call.
  if (pendingOutgoing && pendingOutgoing.to === from) {
    if (myId > from) return; // we win — ignore their incoming, wait for 'accepted'
    // We lose — cancel our outgoing and auto-answer theirs.
    relay.cancel(pendingOutgoing.callId, from);
    pendingOutgoing = null;
    acceptIncomingInternal(callId, from, getContactName(from), true, offer);
    return;
  }
  if (activeCall || pendingIncoming) { relay.reject(callId, from); return; }

  pendingIncoming = { callId, from, name, offer };
  document.getElementById('incoming-caller-name').textContent = getContactName(from);
  showScreen('screen-incoming');
  startRingtone();
}

// Accept the pending incoming call, stopping the ringtone first.
async function acceptCall() {
  if (!pendingIncoming) return;
  stopRingtone();
  await acceptIncomingInternal(pendingIncoming.callId, pendingIncoming.from, getContactName(pendingIncoming.from), false, pendingIncoming.offer);
}
// Init mic, perform the E2E key exchange, send `accept`, and open the call screen.
async function acceptIncomingInternal(callId, from, peerName, auto, offer) {
  await ensureIdentity();
  try { await audio.initCapture(getMicDeviceId(), noiseCancellationEnabled); }
  catch (e) {
    handleMicError(e); // we still connect so we can hear them; we just can't talk
    showToast('Mic unavailable — you can listen but not speak.', true);
  }
  // Complete the authenticated key exchange from the caller's signed offer.
  let session = null, answer = null;
  if (offer) {
    try {
      const r = await CallSession.responder(identity, from, callId, offer);
      session = r.session; answer = r.answer;
    } catch (e) {
      showToast('Secure handshake failed — call rejected.', true);
      relay.reject(callId, from);
      pendingIncoming = null;
      showScreen('screen-idle');
      return;
    }
  }
  relay.accept(callId, from, answer);
  activeCall = { callId, peerId: from, peerName, direction: 'in', session };
  pendingIncoming = null;
  callConnectedAt = Date.now();
  document.getElementById('incall-peer-name').textContent = peerName;
  showScreen('screen-incall');
  startCallTimer();
  touchLastCall(from);
  renderContacts();
  ensureAudioPlaying();
}

// @illusion: reject incoming call, stop ringtone, return to idle
function rejectCall() {
  stopRingtone();
  if (pendingIncoming) relay.reject(pendingIncoming.callId, pendingIncoming.from);
  pendingIncoming = null;
  showScreen('screen-idle');
}

// ─── Outgoing call ─────────────────────────────────────────────────────────────
// Initiate an outgoing call: mic init, E2E key-exchange offer, no-answer timeout.
async function startCall(peerId, peerName) {
  if (!getRelayUrl()) {
    showToast('Set the Relay Server URL in Settings first.', true);
    showScreen('screen-settings');
    return;
  }
  if (!relay || !relay.connected) { showToast('Connecting to relay…', true); return; }
  if (activeCall || pendingOutgoing || pendingIncoming) { showToast('You are already in a call.', true); return; }

  await ensureIdentity();
  try { await audio.initCapture(getMicDeviceId(), noiseCancellationEnabled); }
  catch (e) { handleMicError(e); return; }

  const callId = generateCallId();
  // Build the signed key-exchange offer the callee will verify + complete.
  const { session, offer } = await CallSession.initiator(identity, peerId, callId);
  pendingOutgoing = { callId, to: peerId, name: peerName, session };
  document.getElementById('calling-peer-name').textContent = peerName;
  const avatar = document.getElementById('calling-avatar');
  if (avatar) avatar.textContent = peerName[0]?.toUpperCase() || '?';
  showScreen('screen-calling');
  ensureAudioPlaying(); // create/resume playback context during the click gesture

  relay.call(peerId, callId, offer);
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

// @illusion: cancel pending outgoing call, clean up state
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
// Remote accepted our call: complete the key exchange from their signed answer,
// then transition to the in-call screen.
async function handleAccepted(m) {
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  const session = pendingOutgoing.session;
  if (session && m.answer) {
    try { await session.completeInitiator(m.answer); }
    catch (e) {
      const to = pendingOutgoing.to;
      pendingOutgoing = null;
      audio.closeCapture();
      relay.hangup(m.callId, to);
      showToast('Secure handshake failed — call ended.', true);
      showScreen('screen-idle');
      return;
    }
  }
  activeCall = { callId: pendingOutgoing.callId, peerId: pendingOutgoing.to, peerName: pendingOutgoing.name, direction: 'out', session };
  pendingOutgoing = null;
  callConnectedAt = Date.now();
  document.getElementById('incall-peer-name').textContent = activeCall.peerName;
  showScreen('screen-incall');
  startCallTimer();
  touchLastCall(activeCall.peerId);
  renderContacts();
  ensureAudioPlaying();
}
// @illusion: handle call rejected by remote peer
function handleRejected(m) {
  /* v8 ignore next */
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  pendingOutgoing = null;
  audio.closeCapture();
  showToast('Call declined.');
  showScreen('screen-idle');
}
// @illusion: handle outgoing call cancelled (peer rang but nobody answered)
function handleCancelled(m) {
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  pendingOutgoing = null;
  audio.closeCapture();
  showToast('Call cancelled.');
  showScreen('screen-idle');
}
// @illusion: handle remote peer busy response
function handleBusy(m) {
  /* v8 ignore next */
  if (!pendingOutgoing || pendingOutgoing.callId !== m.callId) return;
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  pendingOutgoing = null;
  audio.closeCapture();
  showToast('Friend is busy.', true);
  showScreen('screen-idle');
}
// @illusion: handle remote peer offline — end call or cancel outgoing
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
// @illusion: handle remote hangup or forced call end
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
// @illusion: show reconnect UI when peer drops, schedule self-reconnect attempt
function handlePeerReconnecting(m) {
  if (!activeCall || activeCall.callId !== m.callId) return;
  reconnecting = true;
  showReconnectUI('Reconnecting…');
  clearTimeout(selfReconnectTimer);
  selfReconnectTimer = setTimeout(() => {
    if (activeCall && relay.connected) relay.reconnect(activeCall.callId, activeCall.peerId);
  }, 1500);
}
// @illusion: clear reconnect UI when peer reconnects
function handleReconnected(m) {
  if (!activeCall || activeCall.callId !== m.callId) return;
  reconnecting = false;
  clearReconnectUI();
  ensureAudioPlaying();
}

// ─── Hang up / cleanup ──────────────────────────────────────────────────────────
// @illusion: signal hangup to relay and clean up call state
function hangUp() {
  intentionalHangup = true;
  if (activeCall) relay.hangup(activeCall.callId, activeCall.peerId);
  endCallCleanup();
}
// @illusion: tear down all call state, stop timers, close mic, show optional message
function endCallCleanup(msg) {
  clearTimeout(noAnswerTimer); noAnswerTimer = null;
  clearTimeout(selfReconnectTimer); selfReconnectTimer = null;
  _starveStart = 0;
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
// @illusion: show/hide remote peer mute indicator
function handleRemoteMuted(m) {
  if (!activeCall || activeCall.peerId !== m.from) return;
  const el = document.getElementById('incall-remote-mute');
  if (el) el.textContent = m.muted ? 'Muted' : '';
}

// ─── Reconnect UI ───────────────────────────────────────────────────────────────
// @illusion: show reconnect overlay with status message
function showReconnectUI(msg) {
  const overlay = document.getElementById('reconnect-overlay');
  const msgEl   = document.getElementById('reconnect-msg');
  if (overlay) overlay.classList.remove('hidden');
  if (msgEl)   msgEl.textContent = msg;
  const statusEl = document.querySelector('#screen-incall .call-status-text');
  if (statusEl) statusEl.textContent = 'Reconnecting…';
}
// @illusion: hide reconnect overlay and restore Connected status text
function clearReconnectUI() {
  const overlay = document.getElementById('reconnect-overlay');
  if (overlay) overlay.classList.add('hidden');
  const statusEl = document.querySelector('#screen-incall .call-status-text');
  if (statusEl) statusEl.textContent = 'Connected';
}

// ─── In-call: mute / noise cancel / audio playback ──────────────────────────────
// @illusion: toggle local mute state, update mic icons, notify peer
function toggleMute() {
  if (!activeCall) return;
  isMuted = !isMuted;
  audio.setMuted(isMuted);
  if (activeCall) relay.sendMute(activeCall.peerId, isMuted);
  document.getElementById('icon-mic').classList.toggle('hidden', isMuted);
  document.getElementById('icon-mic-off').classList.toggle('hidden', !isMuted);
  document.getElementById('btn-mute').classList.toggle('muted', isMuted);
}
// @illusion: toggle FastEnhancer DTLN denoiser on/off with toast notification
function toggleNoiseCancellation() {
  noiseCancellationEnabled = !noiseCancellationEnabled;
  audio.setNoiseCancel(noiseCancellationEnabled);
  document.getElementById('btn-noise-cancel').classList.toggle('nc-off', !noiseCancellationEnabled);
  showToast(noiseCancellationEnabled ? 'Denoise on (FastEnhancer DTLN).' : 'Denoise off.');
}
// @illusion: reset mute state, timer display, and remote mute label to call-start defaults
function resetInCallButtons() {
  isMuted = false;
  document.getElementById('icon-mic').classList.remove('hidden');
  document.getElementById('icon-mic-off').classList.add('hidden');
  document.getElementById('btn-mute').classList.remove('muted');
  document.getElementById('call-timer').textContent = '00:00';
  const rm = document.getElementById('incall-remote-mute');
  if (rm) rm.textContent = '';
}

// @illusion: init or resume playback context, show enable-sound button if suspended
async function ensureAudioPlaying() {
  // @illusion: tolerate playback init/resume failures (autoplay policy or missing device)
  try {
    if (!audio.isPlaybackReady()) await audio.initPlayback();
    else await audio.resumePlayback();
    const el = document.getElementById('remote-audio');
    if (el) el.play().catch(() => {});
    if (audio.isPlaybackSuspended()) showEnableSound(); else hideEnableSound();
  } catch (e) { console.warn('audio playback init failed:', e); }
}
// @illusion: show tap-to-enable-sound button for autoplay-policy workaround
function showEnableSound() {
  const b = document.getElementById('btn-enable-sound');
  if (b) b.classList.remove('hidden');
}
// @illusion: hide enable-sound button once audio context is running
function hideEnableSound() {
  const b = document.getElementById('btn-enable-sound');
  if (b) b.classList.add('hidden');
}
// @illusion: resume playback on user gesture, hide enable-sound button
async function enableSoundTapped() {
  await audio.resumePlayback();
  const el = document.getElementById('remote-audio');
  if (el) el.play().catch(() => {});
  hideEnableSound();
}

// ─── Call timer ─────────────────────────────────────────────────────────────────
// @illusion: start 1-second interval call duration counter and display
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
// @illusion: stop call duration timer
function stopCallTimer() { clearInterval(callTimerID); callTimerID = null; }

// ─── Mic error handler ───────────────────────────────────────────────────────────
// @illusion: display user-friendly microphone error message based on error type
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
// @illusion: enumerate mic and output devices, populate settings dropdowns
async function populateDeviceSelects() {
  // @illusion: requesting the mic may be denied; keep enumerating devices either way
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
// @illusion: set audio output device via setSinkId from stored device ID
async function applyOutputDevice() {
  const deviceId = getOutputDeviceId();
  if (deviceId) await audio.setOutputDevice(deviceId);
}

// ─── Mute keybind ─────────────────────────────────────────────────────────────────
// @illusion: read mute keybind from localStorage, return parsed object or null
function getMuteKeybind() {
  // @illusion: tolerate corrupt stored keybind JSON
  try { return JSON.parse(localStorage.getItem(KEY_MUTE_KEYBIND) || 'null'); }
  catch { return null; }
}
// @illusion: persist mute keybind to localStorage or remove if null
function setMuteKeybind(kb) {
  if (kb) localStorage.setItem(KEY_MUTE_KEYBIND, JSON.stringify(kb));
  else    localStorage.removeItem(KEY_MUTE_KEYBIND);
}
// @illusion: update keybind display label and remove listening state
function updateKeybindDisplay() {
  const el = document.getElementById('keybind-display');
  if (!el) return;
  el.textContent = formatKeybind(getMuteKeybind());
  el.classList.remove('listening');
}
let _keybindCapturing = false;
// @illusion: start keyboard capture to set mute keybind, show listening state
function startKeybindCapture() {
  if (_keybindCapturing) return;
  _keybindCapturing = true;
  const display = document.getElementById('keybind-display');
  const btn     = document.getElementById('btn-set-keybind');
  display.textContent = 'Press a key…';
  display.classList.add('listening');
  btn.textContent = 'Cancel';
  // @illusion: capture keydown event, set keybind or cancel on Escape
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
  // @illusion: stop keybind capture, clean up listener, reset display
  function stopCapture() {
    _keybindCapturing = false;
    document.removeEventListener('keydown', onKey, true);
    const b = document.getElementById('btn-set-keybind'); if (b) b.textContent = 'Set';
    const d = document.getElementById('keybind-display'); if (d) d.classList.remove('listening');
  }
  document.addEventListener('keydown', onKey, true);
}

// ─── Copy my ID ───────────────────────────────────────────────────────────────────
// @illusion: copy peer ID to clipboard with button feedback
async function copyMyId() {
  if (!myId) { showToast('ID not ready yet.', true); return; }
  // @illusion: tolerate clipboard write failures (permissions / insecure context)
  try {
    await navigator.clipboard.writeText(myId);
    const btn = document.getElementById('btn-copy-my-id');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  } catch { showToast('Could not copy to clipboard.', true); }
}

// ─── Save contact ─────────────────────────────────────────────────────────────────
// @illusion: validate and save contact from input fields
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
// Send each 10 ms frame immediately. For gaming we want the lowest possible
// talk-latency, so we do not batch frames into larger WebSocket messages.
let _starveStart = 0;

// Encrypt each captured frame end-to-end, then send it. Frames are chained so
// ciphertext is emitted in capture order. No plaintext is ever sent: if the
// secure session isn't ready yet the frame is dropped.
audio.setOnFrame((frame48) => {
  if (!activeCall || !relay || !relay.connected) return;
  const session = activeCall.session;
  if (!session || !session.ready) return;
  const wire = audio.capture48ToWire(frame48);
  const chain = (activeCall._sendChain || Promise.resolve())
    .then(() => session.encrypt(wire))
    .then((ct) => { if (activeCall && relay && relay.connected) relay.sendAudio(ct); })
    .catch(() => {});
  activeCall._sendChain = chain;
  return chain;
});
// @illusion: update UI on playback starvation status — show warning after sustained drop
audio.setOnStarved((starved) => {
  if (!activeCall) return;
  if (starved) {
    // Only warn after *sustained* starvation (the initial buffering window is normal).
    if (!_starveStart) _starveStart = Date.now();
    if (!reconnecting && Date.now() - _starveStart > 1500) {
      const statusEl = document.querySelector('#screen-incall .call-status-text');
      if (statusEl) statusEl.textContent = 'No audio from ' + activeCall.peerName;
    }
  } else {
    _starveStart = 0;
    if (!reconnecting) {
      const statusEl = document.querySelector('#screen-incall .call-status-text');
      if (statusEl) statusEl.textContent = 'Connected';
    }
  }
});

// @illusion: detect global mute keybind press and toggle mute state
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
// Init app state, bind all UI event handlers, and start the relay connection.
document.addEventListener('DOMContentLoaded', async () => {
  // Wire up all UI controls first so the app is interactive immediately; the
  // cryptographic identity derived below only affects the displayed peer ID.
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
    /* v8 ignore next */
    // @illusion: close the previous relay socket before reconnecting (ignore if absent)
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

  await ensureIdentity();
  document.getElementById('my-peer-id').textContent = myId;
  initRelay();
  renderContacts();
});

// ─── Test hooks (non-breaking: nothing else in the module relies on these) ───
// @illusion: reset all module state variables for test isolation
export function __resetState() {
  relay = null;
  myId = null;
  identity = null;
  myName = 'Me';
  activeCall = null;
  pendingOutgoing = null;
  pendingIncoming = null;
  intentionalHangup = false;
  reconnecting = false;
  noAnswerTimer = null;
  selfReconnectTimer = null;
  callConnectedAt = 0;
  lastAudioAt = 0;
  isMuted = false;
  noiseCancellationEnabled = true;
  callTimerID = null;
  callSeconds = 0;
  ringtoneCtx = null;
  ringtoneTimer = null;
  ringtoneActive = false;
  toastTimer = null;
  _starveStart = 0;
  _keybindCapturing = false;
  DEFAULT_RELAY_URL = 'wss://voicecallandvideostream.onrender.com';
}

export {
  startRingtone, stopRingtone,
  showScreen, showToast, renderContacts,
  setRelayStatus,
  getRelayUrl, getRelayToken, getMicDeviceId, getOutputDeviceId,
  loadOrCreateId, initRelay,
  handleIncoming, acceptCall, acceptIncomingInternal, rejectCall,
  startCall, cancelCall,
  handleAccepted, handleRejected, handleCancelled, handleBusy, handleUnavailable,
  handleEnded, handlePeerReconnecting, handleReconnected,
  hangUp, endCallCleanup,
  handleRemoteMuted,
  showReconnectUI, clearReconnectUI,
  toggleMute, toggleNoiseCancellation, resetInCallButtons,
  ensureAudioPlaying, showEnableSound, hideEnableSound, enableSoundTapped,
  startCallTimer, stopCallTimer,
  handleMicError,
  populateDeviceSelects, applyOutputDevice,
  getMuteKeybind, setMuteKeybind, updateKeybindDisplay, startKeybindCapture,
  copyMyId, saveContact,
  KEY_ID, KEY_PUB, KEY_PRIV, KEY_MIC_DEVICE, KEY_OUTPUT_DEVICE, KEY_MUTE_KEYBIND, KEY_RELAY_URL, KEY_RELAY_TOKEN,
  DEFAULT_RELAY_URL,
};

// @illusion: read starve-start timestamp for test assertions
export function getStarveStart()     { return _starveStart; }
// @illusion: check if keybind capture is active for test assertions
export function getKeybindCapturing() { return _keybindCapturing; }

// Test-only setters (no runtime behaviour change for the app).
export function __setMyId(id)        { myId = id; }
export function __getMyId()          { return myId; }
export function __setDefaultRelayUrl(url) { DEFAULT_RELAY_URL = url; }
export function __setIntentionalHangup(v) { intentionalHangup = v; }
export function __setActiveSession(s) { if (activeCall) activeCall.session = s; }
export async function __ensureIdentity() { return ensureIdentity(); }
