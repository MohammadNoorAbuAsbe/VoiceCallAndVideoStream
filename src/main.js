// ─────────────────────────────────────────────────────────────────────────────
//  VoiceCall — PeerJS-based, full-mesh group calls (up to 6 participants)
//
//  How it works:
//    • Each user has a persistent Peer ID stored in localStorage.
//    • They share their ID with a friend once (like a phone number).
//    • 1-to-1 or group (up to 6): select contacts on home screen, tap Call.
//    • Full-mesh P2P: each participant calls every other — no server needed.
//    • Audio travels directly P2P after signaling; relay only handles handshake.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Storage keys ────────────────────────────────────────────────────────────
const KEY_ID       = 'vcall_peer_id';
const KEY_CONTACTS = 'vcall_contacts';   // JSON: [{id, name, lastCall}]
const KEY_SETTINGS = 'vcall_settings';   // JSON: audio/noise settings

// ─── Constants ───────────────────────────────────────────────────────────────
const MAX_GROUP = 6;   // you + 5 others

// ─── State ───────────────────────────────────────────────────────────────────
let peer         = null;                // PeerJS Peer instance
let activeCalls  = new Map();           // peerId → MediaConnection
let localStream  = null;                // MediaStream from getUserMedia
let isMuted      = false;
let callTimerID  = null;
let callSeconds  = 0;

// ─── RNNoise / ML Noise Cancellation ─────────────────────────────────────────
const KEY_NC          = 'vcall_nc';    // 'true' | 'false'
let ncEnabled         = localStorage.getItem(KEY_NC) !== 'false';  // default ON
let wasmBinary        = null;          // cached rnnoise.wasm ArrayBuffer
let audioCtx          = null;          // one AudioContext reused across calls
let workletAdded      = false;         // audioWorklet.addModule called?
let workletNode       = null;          // AudioWorkletNode for active call
let audioSrc          = null;          // MediaStreamSourceNode for active call
let processedStream   = null;          // clean stream → passed to PeerJS

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

<<<<<<< Updated upstream
// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(KEY_SETTINGS) || '{}'); }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(s));
}

/** Build getUserMedia audio constraints from current settings. */
function getAudioConstraints() {
  const s = loadSettings();
  const c = {
    noiseSuppression: s.noiseSuppression !== false,
    echoCancellation: s.echoCancellation !== false,
    autoGainControl:  s.autoGainControl  !== false,
  };
  if (s.inputDeviceId) c.deviceId = { exact: s.inputDeviceId };
  return c;
}

/** Populate the device <select> dropdowns on the settings screen. */
async function populateDeviceDropdowns() {
  // Briefly request permission so device labels are revealed
  if (!localStream) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch (_) {}
  }
  let devices;
  try { devices = await navigator.mediaDevices.enumerateDevices(); }
  catch { devices = []; }

  const inputs  = devices.filter(d => d.kind === 'audioinput');
  const outputs = devices.filter(d => d.kind === 'audiooutput');
  const s       = loadSettings();

  const selIn  = document.getElementById('select-input-device');
  const selOut = document.getElementById('select-output-device');

  selIn.innerHTML = '<option value="">Default</option>' +
    inputs.map(d => `<option value="${escHtml(d.deviceId)}" ${d.deviceId === s.inputDeviceId ? 'selected' : ''}>${escHtml(d.label || 'Microphone ' + d.deviceId.slice(0, 6))}</option>`).join('');

  selOut.innerHTML = '<option value="">Default</option>' +
    outputs.map(d => `<option value="${escHtml(d.deviceId)}" ${d.deviceId === s.outputDeviceId ? 'selected' : ''}>${escHtml(d.label || 'Speaker ' + d.deviceId.slice(0, 6))}</option>`).join('');
}

/** Apply the chosen output device to all current (and future) audio elements. */
function applyOutputDevice(deviceId) {
  document.querySelectorAll('#audio-container audio').forEach(audio => {
    if (typeof audio.setSinkId === 'function' && deviceId) {
      audio.setSinkId(deviceId).catch(() => {});
    }
  });
}

/** Apply noise processing constraints to the live local stream without restarting. */
async function applyNoiseConstraints() {
  if (!localStream) return;
  const s = loadSettings();
  const constraints = {
    noiseSuppression: s.noiseSuppression !== false,
    echoCancellation: s.echoCancellation !== false,
    autoGainControl:  s.autoGainControl  !== false,
  };
  for (const track of localStream.getAudioTracks()) {
    try { await track.applyConstraints(constraints); } catch (_) {}
  }
}

/** Switch the active microphone mid-call (or just saves the preference if idle). */
async function switchMicDevice(deviceId) {
  if (!localStream) return; // not in a call — setting saved, will apply on next call
  const oldTrack = localStream.getAudioTracks()[0];
  let newStream;
  try {
    const constraints = getAudioConstraints();
    if (deviceId) constraints.deviceId = { exact: deviceId };
    newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
  } catch (e) {
    showToast('Could not switch microphone: ' + e.message, true);
    return;
  }
  const newTrack = newStream.getAudioTracks()[0];
  newTrack.enabled = !isMuted; // preserve mute state

  // Swap track in localStream
  localStream.removeTrack(oldTrack);
  localStream.addTrack(newTrack);
  oldTrack.stop();

  // Replace track in every live peer connection
  for (const call of activeCalls.values()) {
    const sender = call.peerConnection?.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) { try { await sender.replaceTrack(newTrack); } catch (_) {} }
  }
  showToast('Microphone switched.');
}

/** Sync all toggle checkboxes (settings screen + in-call sheet) to stored settings. */
function syncSettingsToggles() {
  const s  = loadSettings();
  const ns = s.noiseSuppression !== false;
  const ec = s.echoCancellation !== false;
  const ag = s.autoGainControl  !== false;
  [
    ['toggle-noise-suppression',       ns],
    ['toggle-echo-cancellation',       ec],
    ['toggle-auto-gain',               ag],
    ['toggle-noise-suppression-sheet', ns],
    ['toggle-echo-cancellation-sheet', ec],
    ['toggle-auto-gain-sheet',         ag],
  ].forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.checked = val;
  });
}

function openSettingsSheet() {
  syncSettingsToggles();
  document.getElementById('settings-overlay').classList.remove('hidden');
}
function closeSettingsSheet() {
  document.getElementById('settings-overlay').classList.add('hidden');
}
function openSettingsScreen() {
  populateDeviceDropdowns();
  syncSettingsToggles();
  showScreen('screen-settings');
=======
// ─── RNNoise helpers ─────────────────────────────────────────────────────────

// Fetch and cache rnnoise.wasm at startup (no AudioContext needed yet)
async function preloadWasm() {
  try {
    const res = await fetch('rnnoise.wasm');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    wasmBinary = await res.arrayBuffer();
  } catch (e) {
    console.warn('[NC] rnnoise.wasm not available — ML noise cancel disabled.', e);
  }
}

// Build AudioContext → AudioWorklet → return a denoised MediaStream.
// Falls back to rawStream on any error so calling always works.
async function buildRNNoiseGraph(rawStream) {
  if (!wasmBinary) return rawStream;
  try {
    // Create (or reuse) AudioContext
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx    = new AudioContext({ sampleRate: 48000 });
      workletAdded = false;
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // Register the worklet module once per AudioContext instance
    if (!workletAdded) {
      await audioCtx.audioWorklet.addModule('noise-worklet.js');
      workletAdded = true;
    }

    teardownRNNoiseGraph(); // disconnect any leftover graph from previous call

    audioSrc    = audioCtx.createMediaStreamSource(rawStream);
    workletNode = new AudioWorkletNode(audioCtx, 'rnnoise-processor', {
      numberOfInputs:    1,
      numberOfOutputs:   1,
      outputChannelCount: [1],
    });
    const dest = audioCtx.createMediaStreamDestination();

    // Clone the cached binary (postMessage without transfer list copies it)
    workletNode.port.postMessage({ type: 'init', wasmBinary });

    audioSrc.connect(workletNode);
    workletNode.connect(dest);
    processedStream = dest.stream;
    return processedStream;
  } catch (e) {
    console.error('[NC] Audio graph error — falling back to raw stream.', e);
    teardownRNNoiseGraph();
    return rawStream;
  }
}

// Disconnect and release all Web Audio nodes for the current call
function teardownRNNoiseGraph() {
  if (workletNode) { try { workletNode.disconnect(); } catch {} workletNode = null; }
  if (audioSrc)    { try { audioSrc.disconnect();    } catch {} audioSrc    = null; }
  processedStream = null;
}

// Sync the checkbox to the current ncEnabled state
function updateNCUI() {
  const chk = document.getElementById('chk-rnnoise');
  if (chk) chk.checked = ncEnabled;
}

// Toggle ML noise cancellation; hot-swaps the audio track mid-call if active
async function toggleNC(checked) {
  ncEnabled = (typeof checked === 'boolean') ? checked : !ncEnabled;
  localStorage.setItem(KEY_NC, String(ncEnabled));
  updateNCUI();

  if (!activeCall?.peerConnection) return;  // no active call — just saved pref

  const sender = activeCall.peerConnection
    .getSenders().find(s => s.track?.kind === 'audio');
  if (!sender) return;

  if (ncEnabled) {
    const processed = await buildRNNoiseGraph(localStream);
    const track = processed?.getAudioTracks()[0];
    if (track) await sender.replaceTrack(track).catch(console.warn);
  } else {
    const rawTrack = localStream?.getAudioTracks()[0];
    if (rawTrack) await sender.replaceTrack(rawTrack).catch(console.warn);
    teardownRNNoiseGraph();
  }
>>>>>>> Stashed changes
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

// ─── Contact selection state (for group calling) ──────────────────────────────
const selectedIds = new Set();

function updateGroupCallBar() {
  const bar   = document.getElementById('group-call-bar');
  const count = document.getElementById('group-call-count');
  const btn   = document.getElementById('btn-group-call');
  if (!bar) return;
  if (selectedIds.size >= 2) {
    bar.classList.remove('hidden');
    count.textContent = selectedIds.size + ' selected';
    btn.textContent   = 'Group Call (' + selectedIds.size + ')';
  } else {
    bar.classList.add('hidden');
  }
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
      <div class="contact-check-wrap">
        <input type="checkbox" class="contact-check" data-id="${escHtml(c.id)}"
               aria-label="Select ${escHtml(c.name)}"
               ${selectedIds.has(c.id) ? 'checked' : ''} />
      </div>
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

  el.querySelectorAll('.contact-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) selectedIds.add(chk.dataset.id);
      else             selectedIds.delete(chk.dataset.id);
      updateGroupCallBar();
    });
  });

  el.querySelectorAll('.btn-call').forEach(btn =>
    btn.addEventListener('click', () => startCall(btn.dataset.id, btn.dataset.name)));

  el.querySelectorAll('.btn-del').forEach(btn =>
    btn.addEventListener('click', () => {
      selectedIds.delete(btn.dataset.id);
      removeContact(btn.dataset.id);
      renderContacts();
      updateGroupCallBar();
    }));
}

// ─── Participant list render (in-call screen) ─────────────────────────────────
function renderParticipants() {
  const el = document.getElementById('participant-list');
  if (!el) return;

  const participants = [
    { id: 'me', name: 'You', connected: true, isMe: true },
    ...Array.from(activeCalls.entries()).map(([id, call]) => ({
      id,
      name: getContactName(id),
      connected: call.open,
      isMe: false
    }))
  ];

  el.innerHTML = participants.map(p => `
    <div class="participant-chip ${p.isMe ? 'me' : (p.connected ? 'connected' : 'connecting')}">
      <div class="participant-avatar">${escHtml(p.name[0].toUpperCase())}</div>
      <span class="participant-name">${escHtml(p.name)}</span>
      ${!p.connected && !p.isMe ? '<span class="participant-status">calling…</span>' : ''}
    </div>`).join('');

  const badge = document.getElementById('incall-count');
  if (badge) {
    const n = participants.length;
    badge.textContent = n + ' in call';
  }

  // Show/hide invite button based on capacity
  const inviteBtn = document.getElementById('btn-invite');
  if (inviteBtn) {
    inviteBtn.disabled = activeCalls.size >= MAX_GROUP - 1;
    inviteBtn.title    = activeCalls.size >= MAX_GROUP - 1 ? 'Call is full (6 max)' : 'Invite someone';
  }
}

// ─── Audio element management ─────────────────────────────────────────────────
function getOrCreateAudio(peerId) {
  const existingId = 'audio-' + peerId;
  let audio = document.getElementById(existingId);
  if (!audio) {
    audio         = document.createElement('audio');
    audio.id      = existingId;
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    document.getElementById('audio-container').appendChild(audio);
    // Apply saved output device (Chrome/Edge only)
    const { outputDeviceId } = loadSettings();
    if (outputDeviceId && typeof audio.setSinkId === 'function') {
      audio.setSinkId(outputDeviceId).catch(() => {});
    }
  }
  return audio;
}

function removeAudio(peerId) {
  const audio = document.getElementById('audio-' + peerId);
  if (audio) audio.remove();
}

// ─── PeerJS initialization ───────────────────────────────────────────────────
function initPeer() {
  const savedId = localStorage.getItem(KEY_ID) || undefined;
  peer = new Peer(savedId, {
    // Free PeerJS cloud — only used for the initial handshake (~2 KB/call).
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
    const inCall = activeCalls.size > 0;

    if (inCall) {
      // Already in call — auto-join if room available, else decline
      if (activeCalls.size >= MAX_GROUP - 1 || !localStream) {
        incomingCall.close();
        return;
      }
      activeCalls.set(incomingCall.peer, incomingCall);
      incomingCall.answer(localStream);
      attachCallHandlers(incomingCall, getContactName(incomingCall.peer));
      showToast(getContactName(incomingCall.peer) + ' joined the call.');
      renderParticipants();
      return;
    }

    // Not in a call — show incoming screen
    activeCalls.set(incomingCall.peer, incomingCall);
    const callerName = getContactName(incomingCall.peer);
    document.getElementById('incoming-caller-name').textContent = callerName;
    showScreen('screen-incoming');
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
    setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 2000);
  });
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
function cleanup() {
  stopCallTimer();
<<<<<<< Updated upstream
  activeCalls.forEach(c => { try { c.close(); } catch (_) {} });
  activeCalls.clear();
=======
  clearTimeout(callTimeout); callTimeout = null;
  teardownRNNoiseGraph();
  if (activeCall)  { activeCall.close();  activeCall  = null; }
>>>>>>> Stashed changes
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  // Remove all dynamic audio elements
  const container = document.getElementById('audio-container');
  if (container) container.innerHTML = '';
  document.getElementById('call-timer').textContent = '00:00';
  const pl = document.getElementById('participant-list');
  if (pl) pl.innerHTML = '';
  const badge = document.getElementById('incall-count');
  if (badge) badge.textContent = '';
  isMuted     = false;
  callSeconds = 0;
  // Reset mute button state
  document.getElementById('icon-mic')?.classList.remove('hidden');
  document.getElementById('icon-mic-off')?.classList.add('hidden');
  document.getElementById('btn-mute')?.classList.remove('muted');
}

// ─── Attach handlers to a call connection ─────────────────────────────────────
// timeoutId: optional per-peer auto-cancel timer handle
function attachCallHandlers(call, peerName, timeoutId = null) {
  call.on('stream', (remoteStream) => {
    clearTimeout(timeoutId);
    // Wire up audio
    getOrCreateAudio(call.peer).srcObject = remoteStream;
    touchLastCall(call.peer);
    renderContacts();
    renderParticipants();
    // Start timer once on first stream
    if (!callTimerID) startCallTimer();
    showScreen('screen-incall');
  });

  call.on('close', () => {
    clearTimeout(timeoutId);
    activeCalls.delete(call.peer);
    removeAudio(call.peer);
    renderParticipants();

    if (activeCalls.size === 0) {
      const wasConnected = document.getElementById('screen-incall').classList.contains('active');
      cleanup();
      renderContacts();
      showScreen('screen-idle');
      if (wasConnected) showToast('Call ended.');
    } else {
      showToast(peerName + ' left the call.');
    }
  });

  call.on('error', (err) => {
    clearTimeout(timeoutId);
    activeCalls.delete(call.peer);
    removeAudio(call.peer);
    renderParticipants();

    if (activeCalls.size === 0) {
      cleanup();
      renderContacts();
      showScreen('screen-idle');
      showToast('Call error: ' + (err.message || String(err)), true);
    } else {
      showToast(peerName + ': connection error.', true);
    }
  });
}

// ─── Outgoing: single contact ─────────────────────────────────────────────────
async function startCall(peerId, peerName) {
  if (!peer || peer.disconnected) {
    showToast('Reconnecting to network…', true);
    peer.reconnect();
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: getAudioConstraints(),
      video: false
    });
  } catch (e) { handleMicError(e); return; }

  document.getElementById('calling-peer-name').textContent = peerName;
  const avatar = document.getElementById('calling-avatar');
  if (avatar) avatar.textContent = peerName[0]?.toUpperCase() || '?';
  showScreen('screen-calling');

<<<<<<< Updated upstream
  const call     = peer.call(peerId, localStream);
  activeCalls.set(peerId, call);
=======
  const streamForCall = ncEnabled ? await buildRNNoiseGraph(localStream) : localStream;
  const call = peer.call(peerId, streamForCall);
  activeCall  = call;
>>>>>>> Stashed changes

  const timeout = setTimeout(() => {
    showToast('No answer.', true);
    cleanup();
    renderContacts();
    showScreen('screen-idle');
  }, 40_000);

  attachCallHandlers(call, peerName, timeout);
}

// ─── Outgoing: group call ─────────────────────────────────────────────────────
async function startGroupCall(peerEntries) {
  // peerEntries: [{id, name}, ...]
  if (!peer || peer.disconnected) {
    showToast('Reconnecting to network…', true);
    peer.reconnect();
    return;
  }

  const capped = peerEntries.slice(0, MAX_GROUP - 1);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: getAudioConstraints(),
      video: false
    });
  } catch (e) { handleMicError(e); return; }

  // Go straight to in-call screen; participants show "calling…" until they answer
  showScreen('screen-incall');
  startCallTimer();

  for (const { id, name } of capped) {
    const call = peer.call(id, localStream);
    activeCalls.set(id, call);

    const timeout = setTimeout(() => {
      if (!call.open) {
        call.close();
        activeCalls.delete(id);
        renderParticipants();
        showToast(name + ' didn\'t answer.');
        if (activeCalls.size === 0) {
          cleanup();
          renderContacts();
          showScreen('screen-idle');
        }
      }
    }, 40_000);

    attachCallHandlers(call, name, timeout);
  }

  renderParticipants();
}

// ─── Accept incoming call ────────────────────────────────────────────────────
async function acceptCall() {
  if (activeCalls.size === 0) return;
  const [peerId, call] = activeCalls.entries().next().value;
  const peerName       = document.getElementById('incoming-caller-name').textContent;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: getAudioConstraints(),
      video: false
    });
  } catch (e) {
    handleMicError(e);
    call.close();
    activeCalls.delete(peerId);
    showScreen('screen-idle');
    return;
  }

  const streamForCall = ncEnabled ? await buildRNNoiseGraph(localStream) : localStream;
  call.answer(streamForCall);
  attachCallHandlers(call, peerName);
}

// ─── Reject / cancel ─────────────────────────────────────────────────────────
function rejectCall() {
  activeCalls.forEach(c => c.close());
  activeCalls.clear();
  cleanup();
  showScreen('screen-idle');
}

function cancelCall() {
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
  cleanup();
  renderContacts();
  showScreen('screen-idle');
}

// ─── Invite sheet (add someone mid-call) ─────────────────────────────────────
function openInviteSheet() {
  const contacts  = loadContacts();
  const inCallIds = new Set(activeCalls.keys());
  const available = contacts.filter(c => !inCallIds.has(c.id));
  const full      = activeCalls.size >= MAX_GROUP - 1;

  const list = document.getElementById('invite-list');
  if (available.length === 0 || full) {
    list.innerHTML = `<p class="invite-empty">${full ? 'Call is full (6 participants max).' : 'All contacts are already in the call.'}</p>`;
  } else {
    list.innerHTML = available.map(c => `
      <div class="invite-row">
        <div class="contact-avatar">${escHtml(c.name[0].toUpperCase())}</div>
        <div class="contact-info">
          <span class="contact-name">${escHtml(c.name)}</span>
        </div>
        <button class="btn btn-primary btn-sm btn-invite-contact"
                data-id="${escHtml(c.id)}"
                data-name="${escHtml(c.name)}">Add</button>
      </div>`).join('');

    list.querySelectorAll('.btn-invite-contact').forEach(btn =>
      btn.addEventListener('click', () => {
        inviteToCall(btn.dataset.id, btn.dataset.name);
        closeInviteSheet();
      })
    );
  }

  document.getElementById('invite-overlay').classList.remove('hidden');
}

function closeInviteSheet() {
  document.getElementById('invite-overlay').classList.add('hidden');
}

async function inviteToCall(peerId, peerName) {
  if (!localStream || activeCalls.has(peerId) || activeCalls.size >= MAX_GROUP - 1) return;

  const call = peer.call(peerId, localStream);
  activeCalls.set(peerId, call);
  renderParticipants();
  showToast('Calling ' + peerName + '…');

  const timeout = setTimeout(() => {
    if (!call.open) {
      call.close();
      activeCalls.delete(peerId);
      renderParticipants();
      showToast(peerName + ' didn\'t answer.');
    }
  }, 40_000);

  attachCallHandlers(call, peerName, timeout);
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
  preloadWasm();
  updateNCUI();

  document.getElementById('chk-rnnoise')
    .addEventListener('change', e => toggleNC(e.target.checked));

  // Initialise toggle states from stored settings
  syncSettingsToggles();

  // Home
  document.getElementById('btn-copy-my-id')
    .addEventListener('click', copyMyId);
  document.getElementById('btn-add-contact')
    .addEventListener('click', () => showScreen('screen-add-contact'));
  document.getElementById('btn-settings')
    .addEventListener('click', openSettingsScreen);

  // Settings screen
  document.getElementById('btn-back-settings')
    .addEventListener('click', () => showScreen('screen-idle'));

  document.getElementById('select-input-device')
    .addEventListener('change', async (e) => {
      const s = loadSettings();
      s.inputDeviceId = e.target.value;
      saveSettings(s);
      await switchMicDevice(e.target.value);
    });

  document.getElementById('select-output-device')
    .addEventListener('change', (e) => {
      const s = loadSettings();
      s.outputDeviceId = e.target.value;
      saveSettings(s);
      applyOutputDevice(e.target.value);
    });

  // Helper: bind a noise toggle (works for both settings screen and in-call sheet)
  function bindNoiseToggle(id, key) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      const s = loadSettings();
      s[key] = el.checked;
      saveSettings(s);
      syncSettingsToggles();   // keep both UIs in sync
      await applyNoiseConstraints();
    });
  }

  bindNoiseToggle('toggle-noise-suppression',       'noiseSuppression');
  bindNoiseToggle('toggle-echo-cancellation',       'echoCancellation');
  bindNoiseToggle('toggle-auto-gain',               'autoGainControl');
  bindNoiseToggle('toggle-noise-suppression-sheet', 'noiseSuppression');
  bindNoiseToggle('toggle-echo-cancellation-sheet', 'echoCancellation');
  bindNoiseToggle('toggle-auto-gain-sheet',         'autoGainControl');

  // In-call settings sheet
  document.getElementById('btn-settings-incall')
    .addEventListener('click', openSettingsSheet);
  document.getElementById('btn-close-settings-sheet')
    .addEventListener('click', closeSettingsSheet);
  document.getElementById('settings-overlay')
    .addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeSettingsSheet();
    });

  // Group call bar
  document.getElementById('btn-group-call')
    .addEventListener('click', () => {
      const entries = loadContacts()
        .filter(c => selectedIds.has(c.id))
        .map(c => ({ id: c.id, name: c.name }));
      selectedIds.clear();
      updateGroupCallBar();
      renderContacts();
      startGroupCall(entries);
    });
  document.getElementById('btn-clear-selection')
    .addEventListener('click', () => {
      selectedIds.clear();
      updateGroupCallBar();
      renderContacts();
    });

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
  document.getElementById('btn-invite')
    .addEventListener('click', openInviteSheet);
  document.getElementById('btn-hangup')
    .addEventListener('click', hangUp);

  // Invite overlay
  document.getElementById('invite-overlay')
    .addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeInviteSheet();
    });
  document.getElementById('btn-close-invite')
    .addEventListener('click', closeInviteSheet);
});
