/**
 * RNNoise AudioWorklet Processor
 *
 * Runs in the audio rendering thread. Receives the rnnoise.wasm binary from
 * the main thread via port message and instantiates it directly — no Emscripten
 * glue required (Emscripten's module fails in AudioWorkletGlobalScope because
 * `window` and `importScripts` are both absent).
 *
 * WASM export map  (from @jitsi/rnnoise-wasm dist/rnnoise.js, stable for v0.0.1):
 *   c = WebAssembly.Memory  |  d = __wasm_call_ctors  |  e = rnnoise_init
 *   f = rnnoise_create      |  g = malloc             |  h = rnnoise_destroy
 *   i = free                |  j = rnnoise_process_frame
 *
 * Import object expected by the WASM:
 *   { "a": { "a": _emscripten_resize_heap, "b": _emscripten_memcpy_big } }
 *
 * Audio flow:
 *   Web Audio gives 128 samples/call; RNNoise needs 480 samples/frame (10 ms @
 *   48 kHz). We accumulate 480 in an input buffer, process, then drain the
 *   output ring 128 samples at a time. Fixed latency: ≤ 10 ms — imperceptible.
 */

const FRAME   = 480;        // RNNoise native frame size (48 kHz × 10 ms)
const QSIZE   = 128;        // Web Audio render quantum
const SCALE   = 32768;      // RNNoise expects PCM range [-32768, 32768]
const RINGLEN = FRAME * 4;  // output ring buffer (4 frames = 40 ms headroom)

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._ready = false;

    // Input accumulator — collect until we have a full 480-sample frame
    this._inBuf   = new Float32Array(FRAME);
    this._inCount = 0;

    // Output ring buffer — store processed frames, drain in 128-sample chunks
    this._outRing  = new Float32Array(RINGLEN);
    this._outWrite = 0;
    this._outRead  = 0;
    this._outAvail = 0;

    this._bypass = false;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'init')   this._load(data.wasmBinary);
      if (data.type === 'bypass') this._bypass = data.value;
    };
  }

  // ─── WASM initialisation ────────────────────────────────────────────────────
  async _load (wasmBinary) {
    try {
      // `memory` is exported BY the WASM, but the resize-heap import needs to
      // reference it. The closure captures the variable; by the time malloc
      // calls resize_heap at runtime, `memory` will already be set.
      let memory = null;

      const imports = {
        a: {
          // _emscripten_resize_heap — called by malloc when the heap is full
          a: (requestedSize) => {
            try {
              const pages = Math.ceil(
                (requestedSize - memory.buffer.byteLength) / 65536
              );
              if (pages > 0) memory.grow(pages);
              return 1;
            } catch { return 0; }
          },
          // _emscripten_memcpy_big — bulk memory copy (large copies only)
          b: (dst, src, n) => {
            new Uint8Array(memory.buffer).copyWithin(dst, src, src + n);
          }
        }
      };

      const { instance } = await WebAssembly.instantiate(wasmBinary, imports);
      const exp = instance.exports;

      memory = exp.c;                          // exported WebAssembly.Memory
      if (typeof exp.d === 'function') exp.d(); // __wasm_call_ctors (runtime init)

      // Allocate per-call RNNoise state and I/O buffers on the WASM heap
      this._state  = exp.f(0);           // rnnoise_create(model = 0 → built-in)
      this._inPtr  = exp.g(FRAME * 4);   // malloc(480 × sizeof float)
      this._outPtr = exp.g(FRAME * 4);

      this._exp    = exp;
      this._memory = memory;
      this._ready  = true;

      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.port.postMessage({ type: 'error', message: String(e) });
    }
  }

  // ─── Process one 480-sample frame through RNNoise ───────────────────────────
  _processFrame () {
    const heap   = new Float32Array(this._memory.buffer);
    const inOff  = this._inPtr  >> 2;  // byte offset → Float32 index (÷4)
    const outOff = this._outPtr >> 2;

    // Scale [-1,1] → [-32768,32768] and copy to WASM heap
    for (let i = 0; i < FRAME; i++) {
      heap[inOff + i] = this._inBuf[i] * SCALE;
    }

    // Run RNNoise denoiser (returns VAD probability, which we ignore)
    this._exp.j(this._state, this._outPtr, this._inPtr);

    // Copy denoised output to ring buffer, scale back to [-1,1]
    for (let i = 0; i < FRAME; i++) {
      this._outRing[(this._outWrite + i) % RINGLEN] = heap[outOff + i] / SCALE;
    }
    this._outWrite  = (this._outWrite + FRAME) % RINGLEN;
    this._outAvail += FRAME;
  }

  // ─── AudioWorkletProcessor.process ─────────────────────────────────────────
  process (inputs, outputs) {
    const inp = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!out) return true;

    const src = inp ?? new Float32Array(QSIZE);

    // Pass-through while bypassed (noise cancellation toggled off)
    if (this._bypass) {
      out.set(src);
      return true;
    }

    // Pass-through while WASM loads (typically < 50 ms at startup)
    if (!this._ready) {
      out.set(src);
      return true;
    }

    // ── Feed 128 samples into the 480-sample accumulator ──
    let offset = 0;
    while (offset < QSIZE) {
      const n = Math.min(FRAME - this._inCount, QSIZE - offset);
      this._inBuf.set(src.subarray(offset, offset + n), this._inCount);
      this._inCount += n;
      offset        += n;
      if (this._inCount === FRAME) {
        this._processFrame();
        this._inCount = 0;
      }
    }

    // ── Drain output ring buffer 128 samples at a time ──
    if (this._outAvail >= QSIZE) {
      for (let i = 0; i < QSIZE; i++) {
        out[i] = this._outRing[(this._outRead + i) % RINGLEN];
      }
      this._outRead   = (this._outRead + QSIZE) % RINGLEN;
      this._outAvail -= QSIZE;
    } else {
      // Not enough output yet — pass through (happens only at the very start)
      out.set(src);
    }

    return true; // keep processor alive
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
