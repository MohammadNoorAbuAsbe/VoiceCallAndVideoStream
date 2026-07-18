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
import { frameToBytes, int16ToFloat32, createNoiseGate } from './audio-codec.js';

const MODEL_SIZE = 'base';   // 'tiny' | 'base' | 'small' — bump to 'small' for max NS

let captureCtx   = null;
let playCtx      = null;
let captureNode  = null;
let playerNode   = null;
let captureStream = null;
let muted        = false;
let noiseCancel  = true;
let denoiser     = null;     // FastEnhancer DTLN instance (main-thread fallback)
let denoiserWorker = null;   // Web Worker running the DTLN off the main thread
let workerReady  = false;    // worker has loaded the model and is accepting frames
let useWorker    = false;    // we successfully created a denoiser worker
let onFrame      = null;     // (Float32Array@48k) => void
let onStarved    = null;     // (boolean) => void

// Noise gate (stateful) used after the denoiser in the capture path. Only runs
// when the denoiser actually processed the frame (mirrors the original behavior
// where raw audio with no denoiser was left untouched).
const noiseGate  = createNoiseGate();

// @illusion: acquire mic, create capture AudioContext+worklet, load neural denoiser
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

  // Initialise the neural denoiser OFF the main thread in a Web Worker so its
  // (heavy) inference never blocks the realtime send path. If Workers are
  // unavailable or the worker fails, we transparently fall back to running the
  // denoiser on the main thread (the original behavior).
  try {
    if (typeof Worker !== 'undefined') {
      const w = new Worker('./denoiser-worker.js', { type: 'module' });
      w.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'ready') workerReady = true;
        else if (m.type === 'error') { console.warn('[audio] worker denoiser failed — main-thread fallback:', m.message); useWorker = false; ensureMainDenoiser(); }
        else if (m.type === 'processed') deliverProcessed(m.frame, true);
      };
      w.onerror = () => { console.warn('[audio] denoiser worker errored — main-thread fallback'); useWorker = false; ensureMainDenoiser(); };
      w.postMessage({ type: 'init', modelSize: MODEL_SIZE });
      denoiserWorker = w;
      useWorker = true;
    }
  } catch (e) {
    console.warn('[audio] could not start denoiser worker — main-thread fallback:', e);
    useWorker = false;
  }
  if (!useWorker) await ensureMainDenoiser();

  captureNode.port.onmessage = ({ data }) => {
    if (data.type !== 'frame' || muted || !onFrame) return;
    handleCaptureFrame(data.frame);
  };

  return captureStream;
}

// Load the denoiser on the main thread (used as a fallback when the worker is
// unavailable). Weights are embedded as base64 in the vendored module.
async function ensureMainDenoiser() {
  if (denoiser || !noiseCancel) return;
  try {
    const model = await loadModel(MODEL_SIZE);
    denoiser = await model.createDenoiser();
  } catch (e) {
    console.warn('[audio] denoiser init failed — sending raw audio:', e);
    denoiser = null;
  }
}

// ─── Capture frame processing ────────────────────────────────────────────────
// Forwards the raw frame to the worker (when active). When running on the main
// thread (fallback), runs the DTLN denoiser here.
// @illusion: dispatch a captured frame to the worker or the main-thread denoiser
function handleCaptureFrame(frame) {
  if (useWorker && workerReady && denoiserWorker && noiseCancel) {
    // Copy: the worklet's buffer is reused, and we hand ownership to the worker.
    denoiserWorker.postMessage({ type: 'frame', frame: frame.slice() });
    return;
  }
  let processed = false;
  if (noiseCancel && denoiser) {
    try { frame = denoiser.processFrame(frame); processed = true; }
    catch (e) { console.warn('[audio] denoiser frame failed:', e); }
  }
  deliverProcessed(frame, processed);
}

// Apply the noise gate (only after the denoiser actually ran) and emit.
// @illusion: run noise gate (if denoised) then forward processed frame
function deliverProcessed(frame, processed) {
  if (processed && noiseCancel) frame = noiseGate.process(frame);
  if (onFrame) onFrame(frame);
}

// @illusion: set callback for processed capture frames
export function setOnFrame(cb)     { onFrame = cb; }
// @illusion: set callback for playback starvation status
export function setOnStarved(cb)   { onStarved = cb; }

// @illusion: set local mute state
export function setMuted(value) {
  muted = value;
}

// @illusion: enable or disable noise cancellation flag
export function setNoiseCancel(value) {
  noiseCancel = value;
}

// @illusion: convert Float32 frame to Int16 wire bytes for relay transport
export function capture48ToWire(frame48) {
  return frameToBytes(frame48);
}

// ─── Playback ────────────────────────────────────────────────────────────────
// @illusion: create playback AudioContext, player worklet, route through hidden audio element
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

// @illusion: resume suspended playback context after user gesture
export async function resumePlayback() {
  if (playCtx) { try { await playCtx.resume(); } catch {} }
}

// @illusion: check if playback pipeline is initialized
export function isPlaybackReady()   { return !!playerNode; }
// @illusion: check if playback context is in suspended state
export function isPlaybackSuspended(){ return !!playCtx && playCtx.state === 'suspended'; }

// @illusion: feed received Int16 audio buffer to player worklet for playback
export function playBytes(arrayBuffer) {
  if (!playerNode) return;
  const f = int16ToFloat32(arrayBuffer);
  playerNode.port.postMessage(f);
}

// ─── Output device (speaker) ──────────────────────────────────────────────────
// @illusion: route audio to specified output device via setSinkId
export async function setOutputDevice(deviceId) {
  const audioEl = document.getElementById('remote-audio');
  if (audioEl && typeof audioEl.setSinkId === 'function' && deviceId) {
    try { await audioEl.setSinkId(deviceId); } catch (e) { console.warn('setSinkId failed:', e); }
  }
}

// @illusion: tear down capture graph, stop mic tracks, destroy denoiser
export function closeCapture() {
  if (denoiserWorker) {
    try { denoiserWorker.postMessage({ type: 'destroy' }); denoiserWorker.terminate(); } catch (_) { /* no-op */ }
    denoiserWorker = null;
  }
  workerReady = false;
  useWorker = false;
  if (denoiser) { try { denoiser.destroy(); } catch (_) {} denoiser = null; }
  if (captureStream) { captureStream.getTracks().forEach(t => t.stop()); captureStream = null; }
  if (captureCtx)   { captureCtx.close().catch(() => {}); captureCtx = null; }
  captureNode = null;
}

// @illusion: close playback context and release player node
export function closePlayback() {
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  playerNode = null;
}
