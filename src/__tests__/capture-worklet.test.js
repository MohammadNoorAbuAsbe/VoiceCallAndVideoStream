// Tests for src/capture-worklet.js — the raw 48 kHz PCM emitter.
// AudioWorkletProcessor / registerProcessor are stubbed globally, then the
// module is dynamically imported so its top-level registerProcessor() runs.
import { describe, it, expect, beforeAll, vi } from 'vitest';

let CaptureProcessor;
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

  const mod = await import('../capture-worklet.js');
  void mod;
  CaptureProcessor = registered['capture-processor'];
});

function makeProcessor() {
  posts = [];
  const p = new CaptureProcessor();
  p.port.postMessage = (m) => posts.push(m);
  return p;
}

const quantum = (value) => [[new Float32Array(128).fill(value)]];

describe('capture-processor', () => {
  it('emits a 512-sample frame after accumulating four 128-sample quanta', () => {
    const p = makeProcessor();
    p.process(quantum(0.0));
    p.process(quantum(0.1));
    p.process(quantum(0.2));
    expect(posts.length).toBe(0); // not yet full
    p.process(quantum(0.3));
    expect(posts.length).toBe(1);
    const frame = posts[0].frame;
    expect(posts[0].type).toBe('frame');
    expect(frame.length).toBe(512);
    // content is q0 || q1 || q2 || q3
    expect(frame[0]).toBe(0.0);
    expect(frame[128]).toBeCloseTo(0.1, 5);
    expect(frame[256]).toBeCloseTo(0.2, 5);
    expect(frame[384]).toBeCloseTo(0.3, 5);
  });

  it('returns true from process (keeps the graph alive)', () => {
    const p = makeProcessor();
    expect(p.process(quantum(0.5))).toBe(true);
  });

  it('wraps correctly past one full frame (FIFO ordering)', () => {
    const p = makeProcessor();
    for (let k = 0; k < 4; k++) p.process(quantum(k));           // frame 1
    expect(posts.length).toBe(1);
    for (let k = 4; k < 8; k++) p.process(quantum(k));           // frame 2
    expect(posts.length).toBe(2);
    expect(posts[1].frame[0]).toBe(4);
    expect(posts[1].frame[384]).toBeCloseTo(7, 5);
  });

  it('emits silence frames when the input channel is disconnected', () => {
    const p = makeProcessor();
    p.process([]);                           // inputs[0] undefined
    p.process([[]]);                         // inputs[0][0] undefined
    p.process([[new Float32Array(0)]]);      // empty channel
    p.process([[new Float32Array(128).fill(9)]]);
    expect(posts.length).toBe(1);
    const frame = posts[0].frame;
    // The only real samples are the last quantum (value 9); the 3 silent
    // quanta occupy the first 384 samples.
    expect(frame[0]).toBe(0);
    expect(frame[384]).toBeCloseTo(9, 5);
  });

  it('does not carry state across separate processor instances', () => {
    const p1 = makeProcessor();
    p1.process(quantum(1));
    p1.process(quantum(1));
    const p2 = makeProcessor();
    p2.process(quantum(2));
    expect(posts.length).toBe(0); // p2 started empty
  });
});
