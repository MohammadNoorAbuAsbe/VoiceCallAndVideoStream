// ─────────────────────────────────────────────────────────────────────────────
//  Audio pipeline (capture → Opus → relay, and relay → Opus → playback)
//
//  Capture : mic → AudioContext@48k → capture-worklet (raw 512-sample frames)
//            → main thread: FastEnhancer DTLN neural denoiser (optional) +
//            noise gate → buffer 960 Float32 samples → Opus encode → relay.
//            The denoiser runs on the MAIN THREAD because it is an ES module
//            (AudioWorkletProcessors cannot import ES modules). 512 samples =
//            10.67 ms @ 48 kHz, the DTLN native frame. Browser echoCancellation
//            + autoGainControl stay on; noise suppression is the DTLN's job.
//  Playback: relay Opus → AudioDecoder → Float32 → player-worklet ring buffer
//            (with adaptive jitter buffering) → destination.
//
//  Opus compression at 20 kbps reduces bandwidth ~20x vs raw Int16 PCM.
//
//  No ICE/TURN: audio simply rides the WebSocket as small binary frames.
// ─────────────────────────────────────────────────────────────────────────────

import { loadModel } from './assets/fastenhancer/api/index.js';
import { createOpusEncoder, createOpusDecoder, createNoiseGate } from './audio-codec.js';

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
let onFrame      = null;     // (Uint8Array) => void — Opus-compressed frame callback
let onStarved    = null;     // (boolean) => void

// Opus encoder state (capture path)
let opusEncoder      = null;
let opusCaptureBuf   = new Float32Array(960);  // 960 samples @ 48kHz = 20ms Opus frame
let opusCaptureCount = 0;

// Opus decoder (playback path)
let opusDecoder      = null;

// Noise gate (stateful) used after the denoiser in the capture path. Only runs
// when the denoiser actually processed the frame (mirrors the original behavior
// where raw audio with no denoiser was left untouched).
const noiseGate  = createNoiseGate();

// @illusion: acquire mic, create capture AudioContext+worklet, load neural denoiser + Opus encoder
export async function initCapture(micDeviceId, noiseCancelEnabled) {
  noiseCancel = noiseCancelEnabled;
  opusCaptureCount = 0;
  opusCaptureBuf = new Float32Array(960);
  if (!opusEncoder) opusEncoder = createOpusEncoder(48000, 20000);

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

// Buffer Float32 frames to 960 samples (20ms @ 48kHz), then Opus-encode and
// emit the compressed bytes via onFrame. Partial buffers are flushed on close.
// @illusion: buffer 960 samples → Opus encode → emit compressed bytes via onFrame
async function deliverProcessed(frame, processed) {
  if (processed && noiseCancel) frame = noiseGate.process(frame);

  // Accumulate into the 960-sample Opus frame buffer.
  const remaining = 960 - opusCaptureCount;
  const n = Math.min(frame.length, remaining);
  opusCaptureBuf.set(frame.subarray(0, n), opusCaptureCount);
  opusCaptureCount += n;

  if (opusCaptureCount >= 960) {
    const fullBuf = opusCaptureBuf;
    opusCaptureBuf = new Float32Array(960);
    opusCaptureCount = 0;
    // Carry over any samples that exceeded the 960 boundary.
    if (n < frame.length) {
      const extra = frame.subarray(n);
      opusCaptureBuf.set(extra, 0);
      opusCaptureCount = extra.length;
    }
    if (onFrame && opusEncoder) {
      const opusBytes = await opusEncoder.encode(fullBuf);
      if (onFrame) onFrame(opusBytes);
    }
  }
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

// @illusion: decode one Opus packet and feed Float32 to player worklet for playback
export async function playOpusFrame(opusBytes) {
  if (!playerNode) return;
  if (!opusDecoder) opusDecoder = createOpusDecoder(48000);
  const f = await opusDecoder.decode(opusBytes);
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

// @illusion: tear down capture graph, stop mic tracks, destroy denoiser + Opus encoder
export function closeCapture() {
  // Flush any remaining buffered samples (pad to 960 with silence).
  if (opusCaptureCount > 0 && opusEncoder && onFrame) {
    const padded = new Float32Array(960);
    padded.set(opusCaptureBuf.subarray(0, opusCaptureCount), 0);
    opusEncoder.encode(padded).then((opusBytes) => {
      if (onFrame) onFrame(opusBytes);
    }).catch(() => {});
  }
  opusCaptureCount = 0;
  opusCaptureBuf = new Float32Array(960);
  if (opusEncoder) { opusEncoder.close(); opusEncoder = null; }
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

// @illusion: close playback context, release player node + Opus decoder
export function closePlayback() {
  if (opusDecoder) { opusDecoder.close(); opusDecoder = null; }
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  playerNode = null;
}
