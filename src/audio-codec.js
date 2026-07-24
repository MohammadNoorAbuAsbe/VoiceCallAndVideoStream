// ─────────────────────────────────────────────────────────────────────────────
//  Audio codec — Opus encoder/decoder (WebCodecs) + noise gate.
//
//  Opus compression replaces the old PCM Int16 conversion to reduce bandwidth
//  ~20x. The encoder uses WebCodecs AudioEncoder (Chromium) and the decoder
//  uses AudioDecoder. Both wrap the callback-based API behind a promise queue
//  so callers can await each compressed/decompressed frame in order.
// ─────────────────────────────────────────────────────────────────────────────

// @illusion: create Opus encoder — wraps AudioEncoder behind a promise queue
export function createOpusEncoder(sampleRate = 48000, bitrate = 20000) {
  let encoder = null;
  let timestamp = 0;
  const outputQueue = [];

  const init = async () => {
    if (encoder) return;
    encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        if (outputQueue.length > 0) outputQueue.shift()(bytes);
      },
      error: (e) => console.error('[opus encoder]', e),
    });
    encoder.configure({ codec: 'opus', sampleRate, numberOfChannels: 1, bitrate });
  };

  return {
    // @illusion: encode one Float32 frame (must be 960 samples @ 48kHz) — returns compressed Opus bytes
    async encode(float32Samples) {
      await init();
      const ts = timestamp;
      timestamp += Math.round(float32Samples.length / sampleRate * 1_000_000);
      const buf = float32Samples.buffer.slice(float32Samples.byteOffset, float32Samples.byteOffset + float32Samples.byteLength);
      const audioData = new AudioData({
        format: 'f32-planar', sampleRate,
        numberOfFrames: float32Samples.length, numberOfChannels: 1,
        timestamp: ts, data: buf,
      });
      encoder.encode(audioData);
      return new Promise((resolve) => { outputQueue.push(resolve); });
    },
    // @illusion: close the encoder and release resources
    close() {
      if (encoder) { try { encoder.close(); } catch {} encoder = null; }
    },
  };
}

// @illusion: create Opus decoder — wraps AudioDecoder behind a promise queue
export function createOpusDecoder(sampleRate = 48000) {
  let decoder = null;
  const outputQueue = [];

  const init = async () => {
    if (decoder) return;
    decoder = new AudioDecoder({
      output: (audioData) => {
        const len = audioData.numberOfFrames;
        const buf = new Float32Array(len);
        audioData.copyTo(buf, { planeIndex: 0 });
        audioData.close();
        if (outputQueue.length > 0) outputQueue.shift()(buf);
      },
      error: (e) => console.error('[opus decoder]', e),
    });
    decoder.configure({ codec: 'opus', sampleRate, numberOfChannels: 1 });
  };

  return {
    // @illusion: decode one Opus packet — returns Float32Array (960 samples @ 48kHz)
    async decode(opusBytes) {
      await init();
      const chunk = new EncodedAudioChunk({ type: 'key', timestamp: 0, data: opusBytes });
      decoder.decode(chunk);
      return new Promise((resolve) => { outputQueue.push(resolve); });
    },
    // @illusion: close the decoder and release resources
    close() {
      if (decoder) { try { decoder.close(); } catch {} decoder = null; }
    },
  };
}

// ─── Noise gate ───────────────────────────────────────────────────────────────
// Hysteresis gate: opens above `openDb`, closes below `closeDb` (both peak
// levels in dBFS). While opening it ramps up by `attack` per frame; while
// closing it fades down by `release` per frame. Returns the (possibly muted or
// scaled) frame; when fully open it returns the input frame untouched.

// @illusion: create hysteresis noise gate with peak-detect and attack/release envelope
export function createNoiseGate(opts = {}) {
  const GATE_OPEN_DB   = opts.openDb  ?? -36;
  const GATE_CLOSE_DB  = opts.closeDb ?? -46;
  const GATE_ATTACK    = opts.attack  ?? 0.08;
  const GATE_RELEASE   = opts.release ?? 0.85;
  const openLin  = Math.pow(10, GATE_OPEN_DB / 20);
  const closeLin = Math.pow(10, GATE_CLOSE_DB / 20);

  let gateOpen = false;
  let gateEnv = 0;

  return {
    // @illusion: apply noise gate — detect peak, open/close, scale by envelope
    process(frame) {
      let peak = 0;
      for (let i = 0; i < frame.length; i++) {
        const a = frame[i] < 0 ? -frame[i] : frame[i];
        if (a > peak) peak = a;
      }
      if (peak > openLin) gateOpen = true;
      else if (peak < closeLin) gateOpen = false;

      gateEnv = gateOpen
        ? Math.min(1, gateEnv + GATE_ATTACK)
        : Math.max(0, gateEnv - GATE_RELEASE);

      if (gateEnv >= 1) return frame;
      const out = new Float32Array(frame.length);
      if (gateEnv > 0) {
        for (let i = 0; i < frame.length; i++) out[i] = frame[i] * gateEnv;
      }
      return out;
    },
    // @illusion: reset noise gate state to closed
    reset() { gateOpen = false; gateEnv = 0; },
    // @illusion: get current envelope level (0–1)
    get env() { return gateEnv; },
    // @illusion: check if gate is currently open
    get isOpen() { return gateOpen; },
  };
}