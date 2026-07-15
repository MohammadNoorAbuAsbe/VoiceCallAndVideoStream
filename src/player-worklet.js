/**
 * Player AudioWorklet Processor
 *
 * Consumes Int16→Float32 PCM frames (48 kHz, mono) posted from the main thread
 * and plays them. Frames are appended to a ring buffer; the audio graph pulls
 * 128-sample quanta from it.
 *
 * A small priming threshold absorbs network jitter: we only start draining once
 * enough audio is buffered, and we go silent (rather than glitching) on a true
 * underrun, re-priming when data returns. This removes the "choppy" artifacts
 * caused by bursty WebSocket delivery.
 */

const RING_LEN = 16384;   // ~341 ms @ 48 kHz headroom
const MIN_FILL = 2048;    // ~43 ms @ 48 kHz priming/jitter threshold

class PlayerProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._buf = new Float32Array(RING_LEN);
    this._w = 0;
    this._r = 0;
    this._count = 0;
    this._primed = false;
    this._starved = false;

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

    if (!this._primed && this._count >= MIN_FILL) this._primed = true;
    if (this._primed && this._count === 0) this._primed = false; // underrun

    if (this._primed) {
      for (let i = 0; i < out.length; i++) {
        if (this._count > 0) {
          out[i] = this._buf[this._r];
          this._r = (this._r + 1) % this._buf.length;
          this._count--;
        } else {
          out[i] = 0; // safety; shouldn't happen while primed
        }
      }
    } else {
      for (let i = 0; i < out.length; i++) out[i] = 0; // buffering / underrun → silence
    }

    // Surface sustained starvation (not the initial buffering window) so the UI
    // can warn about one-way audio without false alarms at call start.
    const starved = !this._primed && this._count < MIN_FILL / 2;
    if (starved !== this._starved) {
      this._starved = starved;
      this.port.postMessage({ type: 'starved', value: starved });
    }
    return true;
  }
}

registerProcessor('player-processor', PlayerProcessor);
