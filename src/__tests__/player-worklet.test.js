// Tests for src/player-worklet.js — the adaptive-jitter-buffer player.
// AudioWorkletProcessor / registerProcessor are stubbed globally, then the
// module is dynamically imported so its top-level registerProcessor() runs.
import { describe, it, expect, beforeAll } from 'vitest';

let PlayerProcessor;
let posts;

beforeAll(async () => {
  class FakeProcessor {
    constructor() {
      this.port = { postMessage() {}, onmessage: null };
    }
  }
  const registered = {};
  globalThis.AudioWorkletProcessor = FakeProcessor;
  globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };

  const mod = await import('../player-worklet.js');
  void mod;
  PlayerProcessor = registered['player-processor'];
});

function makeProcessor() {
  posts = [];
  const p = new PlayerProcessor();
  p.port.postMessage = (m) => posts.push(m);
  return p;
}

// Feed `nFrames` 128-sample frames each filled with `value` into the worklet.
function feed(p, nFrames, value = 1) {
  for (let i = 0; i < nFrames; i++) {
    p.port.onmessage({ data: new Float32Array(128).fill(value) });
  }
}

// Pull one 128-sample quantum from the player into `out` and return it.
function drain(p, out = new Float32Array(128)) {
  p.process(undefined, [[out]]);
  return out;
}

describe('player-processor', () => {
  it('outputs silence and is not primed before enough is buffered', () => {
    const p = makeProcessor();
    feed(p, 2); // 256 < 384 initial target
    expect(p._primed).toBe(false);
    const out = drain(p);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('returns true from process', () => {
    const p = makeProcessor();
    expect(p.process(undefined, [[new Float32Array(128)]]).valueOf()).toBe(true);
  });

  it('primes after the target is reached and plays buffered audio FIFO', () => {
    const p = makeProcessor();
    // Feed 8 frames, each with a distinct tag so we can verify ordering.
    for (let k = 0; k < 8; k++) p.port.onmessage({ data: new Float32Array(128).fill(k) });
    const out = drain(p); // priming happens inside process, not on feed
    expect(p._primed).toBe(true);
    expect(out[0]).toBe(0);         // oldest frame first
    expect(out[127]).toBe(0);
    // After 128 samples we move to frame 1.
    const outs = [];
    for (let i = 0; i < 6; i++) outs.push(drain(p));
    // Eventually frame 1's value (1) appears.
    expect(outs.some((o) => o[0] === 1)).toBe(true);
  });

  it('grows the priming target on underrun', () => {
    const p = makeProcessor();
    feed(p, 5); // reach target 640 on the first drain
    const before = p._target;
    drain(p); // primes
    expect(p._primed).toBe(true);
    // Drain until the buffer empties (underrun).
    let guard = 0;
    while (p._count > 0 && guard++ < 1000) drain(p);
    // The moment count hit 0 while primed, the target should have grown.
    expect(p._target).toBe(Math.min(2048, before + 256));
    expect(p._primed).toBe(false);
  });

  it('shrinks the target back down after a steady stretch', () => {
    const p = makeProcessor();
    feed(p, 5);
    drain(p);
    const before = p._target;
    // Keep feeding + draining so we stay primed and accumulate steady samples.
    for (let i = 0; i < 500; i++) {
      feed(p, 1);
      drain(p);
    }
    expect(p._target).toBeLessThan(before); // shrank toward FLOOR
    expect(p._target).toBeGreaterThanOrEqual(256); // new FLOOR
  });

  it('posts a starved event on underrun and clears it when refilled', () => {
    const p = makeProcessor();
    feed(p, 5);
    drain(p); // prime
    // Drain to empty → starved becomes true.
    let guard = 0;
    while (p._count > 0 && guard++ < 1000) drain(p);
    const starvedTrue = posts.find((m) => m.type === 'starved' && m.value === true);
    expect(starvedTrue).toBeTruthy();
    // Refill then drain → starved becomes false (posted on change).
    feed(p, 5);
    drain(p);
    const starvedFalse = posts.find((m) => m.type === 'starved' && m.value === false);
    expect(starvedFalse).toBeTruthy();
  });

  it('preserves FIFO order across a ring-buffer wrap (within capacity)', () => {
    const p = makeProcessor();
    const N = 16384 / 128; // exactly fills the ring
    for (let k = 0; k < N; k++) p.port.onmessage({ data: new Float32Array(128).fill(k) });
    // Drain everything; each 128-sample output should reflect frames in order.
    const seen = [];
    for (let i = 0; i < N; i++) seen.push(drain(p)[0]);
    for (let k = 0; k < N; k++) expect(seen[k]).toBe(k);
    // Feed another N frames and ensure ordering continues without corruption.
    for (let k = N; k < 2 * N; k++) p.port.onmessage({ data: new Float32Array(128).fill(k) });
    const seen2 = [];
    for (let i = 0; i < N; i++) seen2.push(drain(p)[0]);
    for (let k = 0; k < N; k++) expect(seen2[k]).toBe(N + k);
  });

  it('does not crash when more than a ring of audio is queued without draining', () => {
    const p = makeProcessor();
    expect(() => feed(p, 300)).not.toThrow();
    expect(() => drain(p)).not.toThrow();
  });

  it('zero-fills the rest of the quantum on a mid-quantum underrun', () => {
    const p = makeProcessor();
    feed(p, 5);       // 640 samples → target reached
    drain(p);          // primes, plays 128, _count = 512
    p.port.onmessage({ data: new Float32Array(64).fill(1) }); // _count = 576
    drain(p); drain(p); drain(p); drain(p); // 576 → 448 → 320 → 192 → 64
    const out = drain(p); // 64 samples played, remainder zero-filled
    expect(out[0]).toBe(1);
    expect(out[63]).toBe(1);
    expect(out[64]).toBe(0); // safety branch (lines 57-58)
  });

  it('returns true and does nothing when there is no output channel', () => {
    const p = makeProcessor();
    expect(p.process(undefined, [[]]).valueOf()).toBe(true);
  });
});
