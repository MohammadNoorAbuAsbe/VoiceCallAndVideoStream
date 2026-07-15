/**
 * Capture AudioWorklet Processor
 *
 * Captures the microphone, runs RNNoise (optional) and posts 480-sample
 * Float32 frames (10 ms @ 48 kHz) to the main thread. The main thread
 * downsamples to 16 kHz and ships the PCM over the relay.
 *
 * WASM export map (from @jitsi/rnnoise-wasm dist/rnnoise.js, v0.0.1):
 *   c = WebAssembly.Memory | d = __wasm_call_ctors | e = rnnoise_init
 *   f = rnnoise_create      | g = malloc           | h = rnnoise_destroy
 *   i = free                | j = rnnoise_process_frame
 */

const FRAME   = 480;   // 48 kHz × 10 ms — RNNoise native frame
const QSIZE   = 128;   // Web Audio render quantum
const SCALE   = 32768;
const RINGLEN = FRAME * 4;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._ready = false;

    // RNNoise input accumulator + output ring
    this._inBuf   = new Float32Array(FRAME);
    this._inCount = 0;
    this._outRing  = new Float32Array(RINGLEN);
    this._outWrite = 0;
    this._outRead  = 0;
    this._outAvail = 0;

    // Raw (un-denoised) accumulator used before RNNoise is ready or when bypassed
    this._rawBuf   = new Float32Array(FRAME);
    this._rawCount = 0;

    this._bypass = false;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'init')   this._load(data.wasmBinary);
      if (data.type === 'bypass') this._bypass = data.value;
    };
  }

  async _load (wasmBinary) {
    try {
      let memory = null;
      const imports = {
        a: {
          a: (requestedSize) => {
            try {
              const pages = Math.ceil((requestedSize - memory.buffer.byteLength) / 65536);
              if (pages > 0) memory.grow(pages);
              return 1;
            } catch { return 0; }
          },
          b: (dst, src, n) => {
            new Uint8Array(memory.buffer).copyWithin(dst, src, src + n);
          }
        }
      };
      const { instance } = await WebAssembly.instantiate(wasmBinary, imports);
      const exp = instance.exports;
      memory = exp.c;
      if (typeof exp.d === 'function') exp.d();
      this._state  = exp.f(0);
      this._inPtr  = exp.g(FRAME * 4);
      this._outPtr = exp.g(FRAME * 4);
      this._exp    = exp;
      this._memory = memory;
      this._ready  = true;
      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.port.postMessage({ type: 'error', message: String(e) });
    }
  }

  _processFrame () {
    const heap  = new Float32Array(this._memory.buffer);
    const inOff  = this._inPtr  >> 2;
    const outOff = this._outPtr >> 2;
    for (let i = 0; i < FRAME; i++) heap[inOff + i] = this._inBuf[i] * SCALE;
    this._exp.j(this._state, this._outPtr, this._inPtr);
    for (let i = 0; i < FRAME; i++) {
      this._outRing[(this._outWrite + i) % RINGLEN] = heap[outOff + i] / SCALE;
    }
    this._outWrite  = (this._outWrite + FRAME) % RINGLEN;
    this._outAvail += FRAME;
  }

  _postRaw (src) {
    let offset = 0;
    while (offset < QSIZE) {
      const n = Math.min(FRAME - this._rawCount, QSIZE - offset);
      this._rawBuf.set(src.subarray(offset, offset + n), this._rawCount);
      this._rawCount += n;
      offset += n;
      if (this._rawCount === FRAME) {
        this.port.postMessage({ type: 'frame', frame: this._rawBuf.slice() });
        this._rawCount = 0;
      }
    }
  }

  process (inputs, _outputs) {
    const inp = inputs[0]?.[0];
    const src = inp ?? new Float32Array(QSIZE);

    // While RNNoise loads (or when bypassed) post raw 480-sample frames.
    if (!this._ready) { this._postRaw(src); return true; }
    if (this._bypass) { this._postRaw(src); return true; }

    // Feed 128 samples into the 480-sample RNNoise accumulator.
    let offset = 0;
    while (offset < QSIZE) {
      const n = Math.min(FRAME - this._inCount, QSIZE - offset);
      this._inBuf.set(src.subarray(offset, offset + n), this._inCount);
      this._inCount += n;
      offset += n;
      if (this._inCount === FRAME) { this._processFrame(); this._inCount = 0; }
    }

    // Drain one processed frame (480 samples) to the main thread.
    if (this._outAvail >= FRAME) {
      const f = new Float32Array(FRAME);
      for (let i = 0; i < FRAME; i++) f[i] = this._outRing[(this._outRead + i) % RINGLEN];
      this._outRead  = (this._outRead + FRAME) % RINGLEN;
      this._outAvail -= FRAME;
      this.port.postMessage({ type: 'frame', frame: f });
    } else {
      this._postRaw(src);
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
