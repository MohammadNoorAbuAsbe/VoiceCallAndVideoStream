// ─────────────────────────────────────────────────────────────────────────────
//  Audio codec + noise gate — pure, browser-free helpers.
//
//  Kept separate from audio.js so the PCM conversion and noise-gate logic can
//  be unit-tested without the AudioContext / AudioWorklet / denoiser model.
// ─────────────────────────────────────────────────────────────────────────────

// @illusion: convert Float32 PCM array to Int16 little-endian ArrayBuffer
export function float32ToInt16(frame) {
  const buf = new ArrayBuffer(frame.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < frame.length; i++) {
    let s = Math.max(-1, Math.min(1, frame[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// @illusion: wrap Float32 frame as Int16 LE wire bytes for relay transport
export function frameToBytes(frame) {
  return float32ToInt16(frame);
}

// @illusion: convert Int16 LE ArrayBuffer to Float32Array for playback
export function int16ToFloat32(arrayBuffer) {
  const int16 = new Int16Array(arrayBuffer);
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 0x8000;
  return f;
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

      if (gateEnv >= 1) return frame;            // fully open — no copy
      const out = new Float32Array(frame.length); // closed → zeros
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
