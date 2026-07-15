/**
 * Capture AudioWorklet Processor
 *
 * Captures the microphone, runs SpeexDSP noise suppression (optional) and posts
 * 480-sample Float32 frames (10 ms @ 48 kHz) to the main thread. The main thread
 * ships the PCM over the relay verbatim (no resampling).
 *
 * Why SpeexDSP (not RNNoise / not browser-native):
 *   - RNNoise (2018) has a characteristic "wind/airy" artifact on full-band 48 kHz.
 *   - Browser-native suppression varies per browser and was the weak link before.
 *   SpeexDSP's preprocess does noise suppression + residual-echo suppression +
 *   AGC in one mature, low-CPU module and operates directly on int16 PCM.
 *
 * WASM export map (from @sapphi-red/speex-preprocess-wasm dist/speex.wasm):
 *   e = memory
 *   f = ___wasm_call_ctors
 *   g = _speex_preprocess_state_init(frameSize, samplingRate)
 *   h = _speex_preprocess_state_destroy(state)
 *   i = _speex_preprocess_run(state, ptr)        // in-place int16
 *   j = _speex_preprocess_ctl(state, request, ptr)
 *   k = _free(ptr)
 *   l = _malloc(size)
 *
 * WASM import map (module "a"):
 *   a = _fd_write   b = _fd_seek   c = _fd_close   d = _emscripten_resize_heap
 */

const FRAME   = 480;   // 48 kHz × 10 ms — Speex native frame
const QSIZE   = 128;   // Web Audio render quantum

// SpeexPreprocessCtlRequest subset we use.
const CTL = {
  SET_DENOISE: 0,
  SET_AGC: 2,
  SET_VAD: 4,
  SET_NOISE_SUPPRESS: 18,
  SET_ECHO_SUPPRESS: 20,
  SET_AGC_MAX_GAIN: 30
};

class CaptureProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this._ready = false;

    // Speex input accumulator (Float32)
    this._inBuf   = new Float32Array(FRAME);
    this._inCount = 0;

    // Raw (un-denoised) accumulator used before Speex is ready or when bypassed
    this._rawBuf   = new Float32Array(FRAME);
    this._rawCount = 0;

    this._bypass = false;
    this._state  = null;
    this._bufPtr = 0;
    this._ctlPtr = 0;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'init')   this._load(data.wasmBinary);
      if (data.type === 'bypass') this._bypass = data.value;
    };
  }

  async _load (wasmBinary) {
    try {
      const self = this;
      const imports = {
        a: {
          // _fd_write — ignore stdout/stderr (Speex does no real I/O).
          a (fd, iov, iovcnt, pnum) {
            let total = 0;
            const dv = new DataView(self._memory.buffer);
            for (let k = 0; k < iovcnt; k++) {
              const len = dv.getUint32(iov + k * 8 + 4, true);
              total += len;
            }
            dv.setUint32(pnum, total, true);
            return 0;
          },
          b () { return 0; },            // _fd_seek
          c () { return 0; },            // _fd_close
          d (requestedSize) {            // _emscripten_resize_heap
            const cur = self._memory.buffer.byteLength;
            if (requestedSize <= cur) return 1;
            const pages = Math.ceil((requestedSize - cur) / 65536);
            try { self._memory.grow(pages); return 1; } catch { return 0; }
          }
        }
      };

      const { instance } = await WebAssembly.instantiate(wasmBinary, imports);
      const exp = instance.exports;
      this._memory = exp.e;
      exp.f(); // ___wasm_call_ctors

      this._state  = exp.g(FRAME, 48000);
      this._bufPtr = exp.l(FRAME * 2);   // int16 process buffer
      this._ctlPtr = exp.l(4);

      const heap32 = new Int32Array(this._memory.buffer);
      const setCtl = (req, val) => {
        heap32[this._ctlPtr >> 2] = val;
        exp.j(this._state, req, this._ctlPtr);
      };
      setCtl(CTL.SET_DENOISE, 1);        // noise suppression ON
      setCtl(CTL.SET_AGC, 1);            // auto gain ON (replaces browser AGC)
      setCtl(CTL.SET_VAD, 0);            // we don't need VAD decisions

      this._exp = exp;
      this._ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (e) {
      this.port.postMessage({ type: 'error', message: String(e) });
    }
  }

  _processFrame () {
    const exp = this._exp;
    const heap = new Int16Array(this._memory.buffer);
    const base = this._bufPtr >> 1;
    for (let i = 0; i < FRAME; i++) {
      let s = Math.max(-1, Math.min(1, this._inBuf[i]));
      heap[base + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    exp.i(this._state, this._bufPtr);
    const f = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) f[i] = heap[base + i] / 0x8000;
    this.port.postMessage({ type: 'frame', frame: f });
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

    // While Speex loads (or when bypassed) post raw 480-sample frames.
    if (!this._ready || this._bypass) { this._postRaw(src); return true; }

    // Feed 128 samples into the 480-sample Speex accumulator; emit when full.
    let offset = 0;
    while (offset < QSIZE) {
      const n = Math.min(FRAME - this._inCount, QSIZE - offset);
      this._inBuf.set(src.subarray(offset, offset + n), this._inCount);
      this._inCount += n;
      offset += n;
      if (this._inCount === FRAME) { this._processFrame(); this._inCount = 0; }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
