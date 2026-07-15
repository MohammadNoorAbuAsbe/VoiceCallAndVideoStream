// ─────────────────────────────────────────────────────────────────────────────
//  Audio pipeline (capture → 16 kHz PCM → relay, and relay → playback)
//
//  Capture : mic → AudioContext@48k → capture-worklet (RNNoise, optional)
//            → 480 Float32 frames → main decimates to 160 @16k → Int16 → relay.
//  Playback: relay Int16 → Float32 → player-worklet ring buffer → destination.
//
//  No ICE/TURN: audio simply rides the WebSocket as small binary frames.
// ─────────────────────────────────────────────────────────────────────────────

let captureCtx   = null;
let playCtx      = null;
let captureNode  = null;
let playerNode   = null;
let captureStream = null;
let muted        = false;
let noiseCancel  = true;
let onFrame      = null;     // (Float32Array@48k) => void
let onStarved    = null;     // (boolean) => void

// One-pole low-pass state for the 48k→16k decimation.
let _lp = 0;

/** Acquire the mic and start the capture graph. Resolves with the raw stream. */
export async function initCapture(micDeviceId, noiseCancelEnabled) {
  noiseCancel = noiseCancelEnabled;

  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(micDeviceId ? { deviceId: { ideal: micDeviceId } } : {}),
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: false, // we run our own (RNNoise); avoid double-processing
    },
    video: false
  });

  captureCtx = new AudioContext({ sampleRate: 48000 });
  await captureCtx.resume(); // <-- critical: a suspended context yields SILENCE

  await captureCtx.audioWorklet.addModule('./capture-worklet.js');
  const wasmResp = await fetch('./assets/rnnoise.wasm');
  const wasmBinary = await wasmResp.arrayBuffer();

  const source = captureCtx.createMediaStreamSource(captureStream);
  captureNode = new AudioWorkletNode(captureCtx, 'capture-processor');

  // Silent sink keeps the worklet processing even though we don't use its output.
  const sink = captureCtx.createGain();
  sink.gain.value = 0;
  source.connect(captureNode);
  captureNode.connect(sink);
  sink.connect(captureCtx.destination);

  captureNode.port.postMessage({ type: 'init', wasmBinary }, [wasmBinary]);
  captureNode.port.postMessage({ type: 'bypass', value: !noiseCancel });

  captureNode.port.onmessage = ({ data }) => {
    if (data.type === 'frame' && !muted && onFrame) onFrame(data.frame);
  };

  return captureStream;
}

export function setOnFrame(cb)     { onFrame = cb; }
export function setOnStarved(cb)   { onStarved = cb; }

export function setMuted(value) {
  muted = value;
}

export function setNoiseCancel(value) {
  noiseCancel = value;
  if (captureNode) captureNode.port.postMessage({ type: 'bypass', value: !noiseCancel });
}

/** Downsample one 48 kHz Float32 frame to 16 kHz (decimate by 3, low-passed). */
function decimate(frame48) {
  const out = new Float32Array(Math.floor(frame48.length / 3));
  let j = 0;
  for (let i = 0; i < frame48.length; i++) {
    _lp += 0.15 * (frame48[i] - _lp);
    if (i % 3 === 0) out[j++] = _lp;
  }
  return out;
}

/** Convert 16 kHz Float32 → Int16 ArrayBuffer for WebSocket binary send. */
export function frameToBytes(frame16) {
  const buf = new ArrayBuffer(frame16.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < frame16.length; i++) {
    let s = Math.max(-1, Math.min(1, frame16[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Wrap an incoming 48 kHz frame as bytes ready to send. */
export function capture48ToWire(frame48) {
  return frameToBytes(decimate(frame48));
}

// ─── Playback ────────────────────────────────────────────────────────────────
export async function initPlayback() {
  playCtx = new AudioContext({ sampleRate: 16000 });
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
  if (captureStream) { captureStream.getTracks().forEach(t => t.stop()); captureStream = null; }
  if (captureCtx)   { captureCtx.close().catch(() => {}); captureCtx = null; }
  captureNode = null;
}

export function closePlayback() {
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  playerNode = null;
}
