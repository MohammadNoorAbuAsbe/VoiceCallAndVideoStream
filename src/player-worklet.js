/**
 * Player AudioWorklet Processor
 *
 * Consumes Int16→Float32 PCM frames (16 kHz, mono) posted from the main thread
 * and plays them. Frames are appended to a ring buffer; the audio graph pulls
 * 128-sample quanta from it. When the buffer is empty, silence is output
 * (covers the brief gap before the first frames arrive).
 */

class PlayerProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._buf = new Float32Array(8192);
    this._w = 0;
    this._r = 0;
    this._count = 0;
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

    for (let i = 0; i < out.length; i++) {
      if (this._count > 0) {
        out[i] = this._buf[this._r];
        this._r = (this._r + 1) % this._buf.length;
        this._count--;
      } else {
        out[i] = 0;
      }
    }

    // Surface underruns so the UI can warn about one-way audio.
    const starved = this._count === 0;
    if (starved !== this._starved) {
      this._starved = starved;
      this.port.postMessage({ type: 'starved', value: starved });
    }
    return true;
  }
}

registerProcessor('player-processor', PlayerProcessor);
