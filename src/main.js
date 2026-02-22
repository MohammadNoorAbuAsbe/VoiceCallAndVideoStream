//  Configuration 
const STUN_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};
const ICE_GATHER_TIMEOUT_MS = 12_000; // max wait for ICE gathering

//  State 
let pc          = null;   // RTCPeerConnection
let localStream = null;   // MediaStream from getUserMedia
let isMuted     = false;
let callTimerID = null;
let callSeconds = 0;

//  UI helpers 
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showHide(id, visible) {
  document.getElementById(id).classList.toggle('hidden', !visible);
}

let toastTimer = null;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 8000 : 2500);
}

// Strip chat-app formatting that breaks SDP parsing:
//  - Discord/Telegram/WhatsApp code blocks (``` ... ``` or `...`)
//  - Windows CRLF / old Mac CR line endings → LF
//  - Any blank lines interspersed by copy/paste
//  - Ensure a trailing newline (required by SDP spec parsers)
function sanitizeSdp(raw) {
  let s = raw.trim();
  // Remove surrounding ``` code fences (Discord, Telegram, etc.)
  s = s.replace(/^```[\w]*\n?/i, '').replace(/```\s*$/i, '');
  // Remove single backtick wrapping
  s = s.replace(/^`/, '').replace(/`$/, '');
  // Normalize line endings to \n
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // SDP lines must not be blank — remove any empty lines that snuck in
  s = s.split('\n').filter(l => l.trim() !== '').join('\n');
  // Ensure trailing newline
  if (!s.endsWith('\n')) s += '\n';
  return s;
}

//  ICE gathering wait 
function waitForIceComplete(peerConn) {
  return new Promise((resolve) => {
    if (peerConn.iceGatheringState === 'complete') {
      resolve(peerConn.localDescription);
      return;
    }
    const timer = setTimeout(() => {
      peerConn.removeEventListener('icegatheringstatechange', handler);
      resolve(peerConn.localDescription); // use best we have so far
    }, ICE_GATHER_TIMEOUT_MS);

    function handler() {
      if (peerConn.iceGatheringState === 'complete') {
        clearTimeout(timer);
        peerConn.removeEventListener('icegatheringstatechange', handler);
        resolve(peerConn.localDescription);
      }
    }
    peerConn.addEventListener('icegatheringstatechange', handler);
  });
}

//  Create RTCPeerConnection 
function createPC() {
  const conn = new RTCPeerConnection(STUN_CONFIG);

  conn.ontrack = (event) => {
    const audio = document.getElementById('remote-audio');
    if (event.streams && event.streams[0]) {
      audio.srcObject = event.streams[0];
    }
  };

  conn.onconnectionstatechange = () => {
    const s = conn.connectionState;
    if (s === 'connected') {
      startCallTimer();
      showScreen('screen-incall');
    } else if (s === 'failed') {
      showToast(
        'Connection failed  your network may use strict NAT.\nTry again or ask your friend to host instead.',
        true
      );
    } else if (s === 'disconnected') {
      showToast('Connection lost. Hanging up...', true);
      setTimeout(hangUp, 2000);
    }
  };

  return conn;
}

//  Mic error handler 
function handleMicError(e) {
  if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
    showToast(
      'Microphone access denied.\n' +
      'Fix: Windows Settings  Privacy  Microphone  enable "Allow desktop apps".',
      true
    );
  } else if (e.name === 'NotFoundError') {
    showToast('No microphone found. Plug one in and try again.', true);
  } else {
    showToast('Could not access microphone: ' + e.message, true);
  }
}

//  Copy to clipboard 
async function copyField(fieldId) {
  const el  = document.getElementById(fieldId);
  const btn = document.querySelector(`[data-copy="${fieldId}"]`);
  try {
    await navigator.clipboard.writeText(el.value);
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
  } catch {
    el.select();
    document.execCommand('copy');
  }
}

//  Call timer 
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

function stopCallTimer() {
  clearInterval(callTimerID);
  callTimerID = null;
}

//  Clean up 
function cleanup() {
  stopCallTimer();
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  const audio = document.getElementById('remote-audio');
  audio.srcObject = null;
  isMuted = false;
  callSeconds = 0;
}

// 
// CALLER FLOW
// 

async function startCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    handleMicError(e);
    return;
  }

  showScreen('screen-caller');
  showHide('caller-gathering', true);
  showHide('caller-share', true);

  pc = createPC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const desc = await waitForIceComplete(pc);

  document.getElementById('offer-sdp').value = desc.sdp;
  showHide('caller-gathering', false);
  showHide('caller-share', false);
  // re-show share panel (it was hidden initially)
  document.getElementById('caller-share').classList.remove('hidden');
}

async function connectCaller() {
  const raw = document.getElementById('answer-sdp-input').value;
  if (!raw.trim()) { showToast("Paste your friend's response code first.", true); return; }

  const sdp = sanitizeSdp(raw);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    // onconnectionstatechange will fire 'connected' and switch screen automatically
  } catch (e) {
    showToast('Invalid response code — ' + (e.message || String(e)), true);
  }
}

// 
// CALLEE FLOW
// 

function joinCall() {
  showScreen('screen-callee');
  showHide('callee-paste', false);
  showHide('callee-share', true);
  // reset to step 1
  document.getElementById('callee-paste').classList.remove('hidden');
  document.getElementById('callee-share').classList.add('hidden');
  document.getElementById('offer-sdp-input').value = '';
}

async function generateAnswer() {
  const raw = document.getElementById('offer-sdp-input').value.trim();
  if (!raw) { showToast("Paste your friend's invite code first.", true); return; }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    handleMicError(e);
    return;
  }

  showHide('callee-paste', true);
  document.getElementById('callee-paste').classList.add('hidden');
  document.getElementById('callee-share').classList.remove('hidden');
  showHide('callee-gathering-hint', false);
  showHide('callee-share-ready', true);
  document.getElementById('callee-gathering-hint').classList.remove('hidden');
  document.getElementById('callee-share-ready').classList.add('hidden');

  pc = createPC();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  const sdp = sanitizeSdp(raw);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
  } catch (e) {
    showToast('Invalid invite code — ' + (e.message || String(e)), true);
    cleanup();
    showScreen('screen-callee');
    document.getElementById('callee-paste').classList.remove('hidden');
    document.getElementById('callee-share').classList.add('hidden');
    return;
  }

  const desc = await waitForIceComplete(pc);
  document.getElementById('answer-sdp').value = desc.sdp;

  document.getElementById('callee-gathering-hint').classList.add('hidden');
  document.getElementById('callee-share-ready').classList.remove('hidden');
}

// 
// IN-CALL CONTROLS
// 

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });

  document.getElementById('icon-mic').classList.toggle('hidden', isMuted);
  document.getElementById('icon-mic-off').classList.toggle('hidden', !isMuted);
  const lbl = document.querySelector('#btn-mute span');
  if (lbl) lbl.textContent = isMuted ? 'Unmute' : 'Mute';
  document.getElementById('btn-mute').classList.toggle('muted', isMuted);
}

function hangUp() {
  cleanup();
  showScreen('screen-idle');
}

// 
// BACK BUTTONS
// 
function goBack() {
  cleanup();
  showScreen('screen-idle');
}

// 
// INIT
// 
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-start-call').addEventListener('click', startCall);
  document.getElementById('btn-join-call').addEventListener('click', joinCall);
  document.getElementById('btn-connect-caller').addEventListener('click', connectCaller);
  document.getElementById('btn-generate-answer').addEventListener('click', generateAnswer);
  document.getElementById('btn-mute').addEventListener('click', toggleMute);
  document.getElementById('btn-hangup').addEventListener('click', hangUp);
  document.getElementById('btn-copy-offer').addEventListener('click', () => copyField('offer-sdp'));
  document.getElementById('btn-copy-answer').addEventListener('click', () => copyField('answer-sdp'));
  document.getElementById('btn-back-caller').addEventListener('click', goBack);
  document.getElementById('btn-back-callee').addEventListener('click', goBack);
});
