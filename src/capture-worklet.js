/**
 * Capture AudioWorklet Processor — raw 48 kHz PCM emitter.
 *
 * Captures the microphone and posts 512-sample Float32 frames (≈10.67 ms @
 * 48 kHz) to the main thread. Noise suppression (FastEnhancer DTLN) and the
 * noise gate run on the MAIN THREAD (see audio.js) because the denoiser is an
 * ES module that cannot be imported inside an AudioWorkletProcessor.
 */

const FRAME  = 512;   // DTLN native frame @ 48 kHz
const QSIZE  = 128;   // Web Audio render quantum

// @illusion: accumulate 128-sample quanta into 512-sample Float32 frames, post to main thread
class CaptureProcessor extends AudioWorkletProcessor {
  // @illusion: init internal 512-sample buffer and counter
  constructor() {
    super();
    this._buf   = new Float32Array(FRAME);
    this._count = 0;
  }

  // @illusion: accumulate 128-sample quanta, post full 512-sample frame to main thread
  process(inputs, _outputs) {
    const inp = inputs[0]?.[0];
    const src = inp ?? new Float32Array(QSIZE);

    // Accumulate 128-sample render quanta into 512-sample frames (512 = 4 × 128).
    let offset = 0;
    while (offset < QSIZE) {
      const n = Math.min(FRAME - this._count, QSIZE - offset);
      this._buf.set(src.subarray(offset, offset + n), this._count);
      this._count += n;
      offset += n;
      if (this._count === FRAME) {
        this.port.postMessage({ type: 'frame', frame: this._buf.slice() });
        this._count = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
