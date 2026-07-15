// ─────────────────────────────────────────────────────────────────────────────
//  Audio pipeline (capture → 48 kHz PCM → relay, and relay → playback)
//
//  Capture : mic → AudioContext@48k → capture-worklet (raw 512-sample frames)
//            → main thread: FastEnhancer DTLN neural denoiser (optional) +
//            noise gate → Int16 → relay (sent verbatim, no resampling).
//            The denoiser runs on the MAIN THREAD because it is an ES module
//            (AudioWorkletProcessors cannot import ES modules). 512 samples =
//            10.67 ms @ 48 kHz, the DTLN native frame. Browser echoCancellation
//            + autoGainControl stay on; noise suppression is the DTLN's job.
//  Playback: relay Int16 → Float32 → player-worklet ring buffer (with adaptive
//            jitter buffering) → destination.
//
//  No ICE/TURN: audio simply rides the WebSocket as small binary frames.
// ─────────────────────────────────────────────────────────────────────────────

import { loadModel } from './assets/fastenhancer/api/index.js';

const MODEL_SIZE = 'base';   // 'tiny' | 'base' | 'small' — bump to 'small' for max NS

let captureCtx   = null;
let playCtx      = null;
let captureNode  = null;
let playerNode   = null;
let captureStream = null;
let muted        = false;
let noiseCancel  = true;
let denoiser     = null;     // FastEnhancer DTLN instance (main thread)
let onFrame      = null;     // (Float32Array@48k) => void
let onStarved    = null;     // (boolean) => void

/** Acquire the mic and start the capture graph. Resolves with the raw stream. */
export async function initCapture(micDeviceId, noiseCancelEnabled) {
  noiseCancel = noiseCancelEnabled;

  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(micDeviceId ? { deviceId: { ideal: micDeviceId } } : {}),
      echoCancellation: true,   // browser AEC (echo); DTLN does noise suppression
      autoGainControl: true,    // browser AGC stabilises level for the DTLN
      noiseSuppression: false,  // FastEnhancer DTLN owns noise suppression
    },
    video: false
  });

  captureCtx = new AudioContext({ sampleRate: 48000 });
  await captureCtx.resume(); // <-- critical: a suspended context yields SILENCE

  await captureCtx.audioWorklet.addModule('./capture-worklet.js');

  const source = captureCtx.createMediaStreamSource(captureStream);
  captureNode = new AudioWorkletNode(captureCtx, 'capture-processor');

  // Silent sink keeps the worklet processing even though we don't use its output.
  const sink = captureCtx.createGain();
  sink.gain.value = 0;
  source.connect(captureNode);
  captureNode.connect(sink);
  sink.connect(captureCtx.destination);

  // Initialise the neural denoiser on the main thread (weights are embedded
  // as base64 in the vendored module — no fetch, no CDN).
  try {
    const model = await loadModel(MODEL_SIZE);
    denoiser = await model.createDenoiser();
  } catch (e) {
    console.warn('[audio] denoiser init failed — sending raw audio:', e);
    denoiser = null;
  }

  captureNode.port.onmessage = ({ data }) => {
    if (data.type !== 'frame' || muted || !onFrame) return;
    onFrame(processCaptureFrame(data.frame));
  };

  return captureStream;
}

// ─── Capture frame processing (main thread) ──────────────────────────────────
// Runs the DTLN denoiser (when enabled) followed by a noise gate that mutes
// near-silence so residual AC hum / keyboard tails between sentences are cut.
function processCaptureFrame(frame) {
  if (noiseCancel && denoiser) {
    try { frame = denoiser.processFrame(frame); }
    catch (e) { console.warn('[audio] denoiser frame failed:', e); }
    return applyNoiseGate(frame);
  }
  return frame;
}

// Noise gate state.
let _gateOpen = false;
let _gateEnv  = 0;
const GATE_OPEN_DB   = -36;   // open (let audio through) above this peak level
const GATE_CLOSE_DB  = -46;   // close (mute) below this peak level (hysteresis)
const GATE_ATTACK    = 0.08;  // ramp-up smoothing per frame when opening
const GATE_RELEASE   = 0.85;  // fast fade per frame when closing
const _gateOpenLin   = Math.pow(10, GATE_OPEN_DB / 20);
const _gateCloseLin  = Math.pow(10, GATE_CLOSE_DB / 20);

function applyNoiseGate(frame) {
  let peak = 0;
  for (let i = 0; i < frame.length; i++) {
    const a = frame[i] < 0 ? -frame[i] : frame[i];
    if (a > peak) peak = a;
  }
  if (peak > _gateOpenLin) _gateOpen = true;
  else if (peak < _gateCloseLin) _gateOpen = false;

  _gateEnv = _gateOpen
    ? Math.min(1, _gateEnv + GATE_ATTACK)
    : Math.max(0, _gateEnv - GATE_RELEASE);

  if (_gateEnv >= 1) return frame;            // fully open — no copy
  const out = new Float32Array(frame.length); // closed → zeros
  if (_gateEnv > 0) {
    for (let i = 0; i < frame.length; i++) out[i] = frame[i] * _gateEnv;
  }
  return out;
}

export function setOnFrame(cb)     { onFrame = cb; }
export function setOnStarved(cb)   { onStarved = cb; }

export function setMuted(value) {
  muted = value;
}

export function setNoiseCancel(value) {
  noiseCancel = value;
}

/** Convert Float32 PCM → Int16 ArrayBuffer for WebSocket binary send. */
export function frameToBytes(frame) {
  const buf = new ArrayBuffer(frame.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < frame.length; i++) {
    let s = Math.max(-1, Math.min(1, frame[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Wrap an incoming 48 kHz frame as bytes, sent verbatim (no resampling). */
export function capture48ToWire(frame48) {
  return frameToBytes(frame48);
}

// ─── Playback ────────────────────────────────────────────────────────────────
export async function initPlayback() {
  playCtx = new AudioContext({ sampleRate: 48000 });
  await playCtx.resume();
  await playCtx.audioWorklet.addModule('./player-worklet.js');
  playerNode = new AudioWorkletNode(playCtx, 'player-processor');

  // Route through a MediaStream so the hidden <audio> element (which supports
  // setSinkId) carries the sound — this also gives us a user-gesture play().
  const dest = playCtx.createMediaStreamDestination();
  playerNode.connect(dest);

  const audioEl = document.getElementById('remote-audio');
  if (audioEl) {
    audioEl.srcObject = dest.stream;
    audioEl.play().catch(() => {});
  }

  playerNode.port.onmessage = ({ data }) => {
    if (data.type === 'starved' && onStarved) onStarved(data.value);
  };
}

export async function resumePlayback() {
  if (playCtx) { try { await playCtx.resume(); } catch {} }
}

export function isPlaybackReady()   { return !!playerNode; }
export function isPlaybackSuspended(){ return !!playCtx && playCtx.state === 'suspended'; }

/** Feed an Int16 ArrayBuffer received from the relay into the player. */
export function playBytes(arrayBuffer) {
  if (!playerNode) return;
  const int16 = new Int16Array(arrayBuffer);
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 0x8000;
  playerNode.port.postMessage(f);
}

// ─── Output device (speaker) ──────────────────────────────────────────────────
export async function setOutputDevice(deviceId) {
  const audioEl = document.getElementById('remote-audio');
  if (audioEl && typeof audioEl.setSinkId === 'function' && deviceId) {
    try { await audioEl.setSinkId(deviceId); } catch (e) { console.warn('setSinkId failed:', e); }
  }
}

export function closeCapture() {
  if (denoiser) { try { denoiser.destroy(); } catch (_) {} denoiser = null; }
  if (captureStream) { captureStream.getTracks().forEach(t => t.stop()); captureStream = null; }
  if (captureCtx)   { captureCtx.close().catch(() => {}); captureCtx = null; }
  captureNode = null;
}

export function closePlayback() {
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  playerNode = null;
}
