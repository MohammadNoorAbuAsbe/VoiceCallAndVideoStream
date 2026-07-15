/**
 * Player AudioWorklet Processor
 *
 * Consumes Int16→Float32 PCM frames (48 kHz, mono) posted from the main thread
 * and plays them. Frames are appended to a ring buffer; the audio graph pulls
 * 128-sample quanta from it.
 *
 * Adaptive jitter buffer: we start with a small priming target (low latency,
 * important for gaming/voice) and only grow it when we actually underrun, then
 * shrink it back once the link is steady. This removes the "choppy" artifacts
 * caused by bursty WebSocket delivery without adding fixed, large delay.
 */

const RING_LEN = 16384;   // ~341 ms @ 48 kHz headroom
const FLOOR    = 320;     // ~6.7 ms minimum priming target
const CEIL     = 2048;    // ~43 ms maximum (only under heavy jitter)
const GROW     = 256;     // grow step on underrun
const SHRINK   = 64;      // shrink step when steady
const STEADY   = 48000;   // samples of glitch-free audio before we shrink (~1 s)

class PlayerProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._buf = new Float32Array(RING_LEN);
    this._w = 0;
    this._r = 0;
    this._count = 0;
    this._primed = false;
    this._starved = false;
    this._target = 640;   // ~13 ms initial priming target
    this._steady = 0;

    this.port.onmessage = ({ data }) => {
      const f = data; // Float32Array
      for (let i = 0; i < f.length; i++) {
        this._buf[this._w] = f[i];
        this._w = (this._w + 1) % this._buf.length;
        this._count++;
      }
    };
  }

  process (_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;

    if (!this._primed && this._count >= this._target) this._primed = true;
    if (this._primed && this._count === 0) {
      // True underrun: grow the target so the next burst has more slack.
      this._primed = false;
      this._target = Math.min(CEIL, this._target + GROW);
      this._steady = 0;
    }

    if (this._primed) {
      for (let i = 0; i < out.length; i++) {
        if (this._count > 0) {
          out[i] = this._buf[this._r];
          this._r = (this._r + 1) % this._buf.length;
          this._count--;
          this._steady++;
        } else {
          out[i] = 0; // safety; shouldn't happen while primed
        }
      }
      // Once we've played a steady stretch cleanly, ease the target back down.
      if (this._steady >= STEADY) {
        this._steady = 0;
        this._target = Math.max(FLOOR, this._target - SHRINK);
      }
    } else {
      for (let i = 0; i < out.length; i++) out[i] = 0; // buffering / underrun → silence
    }

    // Surface sustained starvation (not the initial buffering window) so the UI
    // can warn about one-way audio without false alarms at call start.
    const starved = !this._primed && this._count < FLOOR / 2;
    if (starved !== this._starved) {
      this._starved = starved;
      this.port.postMessage({ type: 'starved', value: starved });
    }
    return true;
  }
}

registerProcessor('player-processor', PlayerProcessor);
