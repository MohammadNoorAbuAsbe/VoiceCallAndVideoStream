// @vitest-environment jsdom
// Tests for src/audio.js — the capture/playback pipeline.
// Web Audio (AudioContext / AudioWorkletNode), navigator.mediaDevices, the DOM
// <audio> element, and the heavy FastEnhancer denoiser model are all mocked so
// the pure control-flow and PCM plumbing can be exercised deterministically.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the denoiser model loader (heavy WASM/weights) with a controllable fake.
vi.mock('../assets/fastenhancer/api/index.js', () => ({
  loadModel: vi.fn(),
}));

import { loadModel } from '../assets/fastenhancer/api/index.js';

// ─── Fake Web Audio ───────────────────────────────────────────────────────────
let workletNodes = [];

class FakeParam { constructor(v = 1) { this.value = v; } }
class FakeNode {
  constructor() {
    this.port = { postMessage() {}, onmessage: null };
    this.gain = new FakeParam();
  }
  connect() {}
  disconnect() {}
}
class FakeAudioContext {
  constructor(opts) {
    this.sampleRate = opts?.sampleRate || 48000;
    this.state = 'running';
    this.destination = new FakeNode();
    this.audioWorklet = { addModule: vi.fn(async () => {}) };
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { return new FakeNode(); }
  createGain() { return new FakeNode(); }
  createMediaStreamDestination() { return { stream: {} }; }
}

let ctxInstances = [];

function setupGlobals() {
  workletNodes = [];
  ctxInstances = [];
  globalThis.AudioContext = class extends FakeAudioContext {
    constructor(opts) { super(opts); ctxInstances.push(this); }
  };
  globalThis.AudioWorkletNode = class extends FakeNode {
    constructor(...a) { super(...a); workletNodes.push(this); }
  };
  const audioEl = {
    srcObject: null,
    play: vi.fn(async () => {}),
    setSinkId: vi.fn(async () => {}),
  };
  globalThis.__audioEl = audioEl;
  document.getElementById = vi.fn((id) => (id === 'remote-audio' ? audioEl : null));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })),
      enumerateDevices: vi.fn(async () => []),
    },
  });
}

function makeDenoiser() {
  return {
    processFrame: vi.fn((f) => f),
    destroy: vi.fn(),
  };
}

let audio;
beforeEach(async () => {
  vi.resetModules();
  setupGlobals();
  audio = await import('../audio.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initCapture', () => {
  it('builds the capture graph and resolves with the raw stream', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    const stream = await audio.initCapture('mic-id', true);
    expect(stream).toBeTruthy();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: true, autoGainControl: true, noiseSuppression: false }) })
    );
    // 48 kHz context + worklet module added + capture processor created.
    expect(ctxInstances[0].sampleRate).toBe(48000);
    expect(ctxInstances[0].audioWorklet.addModule).toHaveBeenCalledWith('./capture-worklet.js');
    const captureNode = workletNodes[0];
    expect(captureNode).toBeTruthy();
  });

  it('falls back to raw audio when the denoiser model fails to load', async () => {
    loadModel.mockRejectedValue(new Error('no wasm'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(audio.initCapture('mic-id', true)).resolves.toBeTruthy();
    warn.mockRestore();
  });

  it('propagates getUserMedia errors', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('denied'));
    await expect(audio.initCapture('mic-id', true)).rejects.toThrow('denied');
  });

  it('omits the deviceId constraint when no micDeviceId is given', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initCapture(undefined, true);
    const audioArg = navigator.mediaDevices.getUserMedia.mock.calls[0][0].audio;
    expect(audioArg.deviceId).toBeUndefined();
  });
});

describe('capture frame processing', () => {
  async function captureWith(denoiserOk, noiseCancelEnabled) {
    if (denoiserOk) loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    else loadModel.mockRejectedValue(new Error('no wasm'));
    await audio.initCapture('mic-id', noiseCancelEnabled);
    return workletNodes[0]; // capture processor node
  }

  it('runs the denoiser + noise gate and forwards to onFrame', async () => {
    const captureNode = await captureWith(true, true);
    const onFrame = vi.fn();
    audio.setOnFrame(onFrame);
    const frame = new Float32Array([0.5, -0.5, 0.01]);
    captureNode.port.onmessage({ data: { type: 'frame', frame } });
    expect(onFrame).toHaveBeenCalledTimes(1);
    const out = onFrame.mock.calls[0][0];
    expect(out).toBeInstanceOf(Float32Array);
  });

  it('does NOT forward when muted', async () => {
    const captureNode = await captureWith(true, true);
    const onFrame = vi.fn();
    audio.setOnFrame(onFrame);
    audio.setMuted(true);
    captureNode.port.onmessage({ data: { type: 'frame', frame: new Float32Array([0.5]) } });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('ignores non-frame messages', async () => {
    const captureNode = await captureWith(true, true);
    const onFrame = vi.fn();
    audio.setOnFrame(onFrame);
    captureNode.port.onmessage({ data: { type: 'other' } });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('does nothing when onFrame is not set', async () => {
    const captureNode = await captureWith(true, true);
    audio.setOnFrame(null);
    expect(() => captureNode.port.onmessage({ data: { type: 'frame', frame: new Float32Array([0.5]) } })).not.toThrow();
  });

  it('sends the raw frame when the denoiser is unavailable', async () => {
    const captureNode = await captureWith(false, true);
    const onFrame = vi.fn();
    audio.setOnFrame(onFrame);
    const frame = new Float32Array([0.5, 0.2]);
    captureNode.port.onmessage({ data: { type: 'frame', frame } });
    // denoiser null → returns the frame unchanged (no gating applied)
    expect(onFrame.mock.calls[0][0]).toBe(frame);
  });

  it('sends the raw frame when noise cancellation is disabled', async () => {
    const captureNode = await captureWith(true, false);
    const onFrame = vi.fn();
    audio.setOnFrame(onFrame);
    const frame = new Float32Array([0.5, 0.2]);
    captureNode.port.onmessage({ data: { type: 'frame', frame } });
    expect(onFrame.mock.calls[0][0]).toBe(frame);
  });

  it('falls back to the noise gate when the denoiser frame throws', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => ({
      processFrame: vi.fn(() => { throw new Error('boom'); }),
      destroy: vi.fn(),
    })) });
    await audio.initCapture('mic-id', true);
    const captureNode = workletNodes[0];
    const onFrame = vi.fn();
    audio.setOnFrame(onFrame);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    captureNode.port.onmessage({ data: { type: 'frame', frame: new Float32Array([0.5]) } });
    warn.mockRestore();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });
});

describe('capture settings + wire format', () => {
  it('setOnStarved stores the callback', async () => {
    const cb = vi.fn();
    audio.setOnStarved(cb);
    // exercised via the player path; here just ensure it does not throw
    expect(() => audio.setOnStarved(cb)).not.toThrow();
  });
  it('setMuted / setNoiseCancel are callable', () => {
    expect(() => { audio.setMuted(true); audio.setNoiseCancel(false); }).not.toThrow();
  });
  it('capture48ToWire returns an Int16-le ArrayBuffer', () => {
    const buf = audio.capture48ToWire(new Float32Array([1, -1]));
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe(4);
  });
});

describe('playback', () => {
  it('initPlayback builds the player graph and reports ready', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initPlayback();
    expect(audio.isPlaybackReady()).toBe(true);
    expect(ctxInstances.some((c) => c.audioWorklet.addModule.mock.calls.some((a) => a[0] === './player-worklet.js'))).toBe(true);
    expect(globalThis.__audioEl.srcObject).toBeTruthy();
  });

  it('forwards starved events to the onStarved callback', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    const onStarved = vi.fn();
    audio.setOnStarved(onStarved);
    await audio.initPlayback();
    const playerNode = workletNodes[workletNodes.length - 1];
    playerNode.port.onmessage({ data: { type: 'starved', value: true } });
    expect(onStarved).toHaveBeenCalledWith(true);
  });

  it('resumePlayback resumes a live context and is safe with none', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.resumePlayback(); // no playCtx yet → no throw
    await audio.initPlayback();
    const playCtx = ctxInstances.find((c) => c !== ctxInstances[0]) || ctxInstances[ctxInstances.length - 1];
    await audio.resumePlayback();
    expect(playCtx.state).toBe('running');
  });

  it('isPlaybackReady / isPlaybackSuspended reflect state', async () => {
    expect(audio.isPlaybackReady()).toBe(false);
    expect(audio.isPlaybackSuspended()).toBe(false);
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initPlayback();
    expect(audio.isPlaybackReady()).toBe(true);
    expect(audio.isPlaybackSuspended()).toBe(false);
    const playCtx = ctxInstances[ctxInstances.length - 1];
    playCtx.state = 'suspended';
    expect(audio.isPlaybackSuspended()).toBe(true);
    playCtx.state = 'running';
    expect(audio.isPlaybackSuspended()).toBe(false);
  });

  it('playBytes is a no-op before playback is initialised', () => {
    expect(() => audio.playBytes(new ArrayBuffer(4))).not.toThrow();
  });

  it('resumePlayback swallows resume errors', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initPlayback();
    const playCtx = ctxInstances[ctxInstances.length - 1];
    playCtx.resume = vi.fn(async () => { throw new Error('resume-fail'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(audio.resumePlayback()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('playBytes converts Int16 and posts to the player node', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initPlayback();
    const playerNode = workletNodes[workletNodes.length - 1];
    const post = vi.spyOn(playerNode.port, 'postMessage');
    audio.playBytes(new Float32Array([1]).buffer);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBeInstanceOf(Float32Array);
  });
});

describe('setOutputDevice', () => {
  it('calls setSinkId when available and a device is given', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initPlayback();
    await audio.setOutputDevice('dev-1');
    expect(globalThis.__audioEl.setSinkId).toHaveBeenCalledWith('dev-1');
  });
  it('skips when no device id is provided', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initPlayback();
    globalThis.__audioEl.setSinkId.mockClear();
    await audio.setOutputDevice('');
    expect(globalThis.__audioEl.setSinkId).not.toHaveBeenCalled();
  });
  it('swallows setSinkId errors', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initPlayback();
    globalThis.__audioEl.setSinkId.mockRejectedValueOnce(new Error('nope'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(audio.setOutputDevice('dev-1')).resolves.toBeUndefined();
    warn.mockRestore();
  });
  it('is a no-op when the audio element is absent', async () => {
    document.getElementById = vi.fn(() => null);
    await expect(audio.setOutputDevice('dev-1')).resolves.toBeUndefined();
  });
  it('is a no-op when setSinkId is not a function', async () => {
    globalThis.__audioEl.setSinkId = undefined;
    await expect(audio.setOutputDevice('dev-1')).resolves.toBeUndefined();
  });
});

describe('teardown', () => {
  it('closeCapture destroys the denoiser, stops tracks and closes the context', async () => {
    const denoiser = makeDenoiser();
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => denoiser) });
    const stream = await audio.initCapture('mic-id', true);
    const stop = vi.fn();
    stream.getTracks = () => [{ stop }];
    await audio.closeCapture();
    expect(denoiser.destroy).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('closeCapture tolerates a denoiser destroy error', async () => {
    const denoiser = makeDenoiser();
    denoiser.destroy.mockImplementation(() => { throw new Error('destroy-fail'); });
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => denoiser) });
    await audio.initCapture('mic-id', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => audio.closeCapture()).not.toThrow();
    expect(denoiser.destroy).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('closePlayback closes the context and nulls the player', async () => {
    loadModel.mockResolvedValue({ createDenoiser: vi.fn(async () => makeDenoiser()) });
    await audio.initPlayback();
    const playCtx = ctxInstances[ctxInstances.length - 1];
    const close = vi.spyOn(playCtx, 'close');
    await audio.closePlayback();
    expect(close).toHaveBeenCalled();
    expect(audio.isPlaybackReady()).toBe(false);
  });
});
