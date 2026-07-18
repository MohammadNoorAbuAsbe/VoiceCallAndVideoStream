// ─────────────────────────────────────────────────────────────────────────────
//  Denoiser Web Worker
//
//  Runs the FastEnhancer DTLN neural noise suppressor OFF the main thread. The
//  main thread forwards each raw 512-sample Float32 frame here; we run the model
//  and post the cleaned frame back. This keeps the (heavy) inference off the
//  realtime audio send path so the main thread stays free for encryption,
//  WebSocket sends, and the UI — removing the jitter the synchronous denoiser
//  used to add.
//
//  If the model fails to load or a frame throws, we echo the input back so the
//  pipeline continues (the main thread still applies the noise gate).
// ─────────────────────────────────────────────────────────────────────────────

import { loadModel } from './assets/fastenhancer/api/index.js';

let denoiser = null;

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    const modelSize = msg.modelSize || 'base';
    try {
      const model = await loadModel(modelSize);
      denoiser = await model.createDenoiser();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  } else if (msg.type === 'frame') {
    if (!denoiser) return; // main thread will fall back / send raw
    try {
      const out = denoiser.processFrame(msg.frame);
      self.postMessage({ type: 'processed', frame: out });
    } catch {
      // Echo the input back so audio keeps flowing even if inference fails.
      self.postMessage({ type: 'processed', frame: msg.frame });
    }
  } else if (msg.type === 'destroy') {
    if (denoiser) { try { denoiser.destroy(); } catch { /* no-op */ } denoiser = null; }
  }
};
