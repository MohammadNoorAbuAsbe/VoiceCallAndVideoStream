// Opus codec + noise-gate tests.
// WebCodecs APIs (AudioEncoder, AudioDecoder, AudioData, EncodedAudioChunk) are
// mocked since they don't exist in jsdom; the mock encoder/decoder do a lossless
// Float32↔Uint8Array round-trip so we can verify the factory wiring, promise
// queue ordering, and close() behaviour.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOpusEncoder, createOpusDecoder, createNoiseGate } from '../audio-codec.js';

// ─── WebCodecs mocks ──────────────────────────────────────────────────────────
// FakeAudioEncoder: on encode(), passes the AudioData's raw buffer through the
// output callback as a Uint8Array chunk (lossless round-trip). The output fires
// asynchronously (next microtask) to match real WebCodecs behaviour, which is
// critical because createOpusEncoder pushes to outputQueue *after* calling encode().
class FakeAudioEncoder {
  constructor({ output }) { this._output = output; }
  configure() {}
  encode(data) {
    const bytes = new Uint8Array(data._opts.data);
    const output = this._output;
    queueMicrotask(() => {
      const FakeChunk = globalThis.__FakeEncodedAudioChunk;
      output(new FakeChunk({ data: bytes }));
    });
  }
  close() {}
}

class FakeAudioDecoder {
  constructor({ output }) { this._output = output; }
  configure() {}
  decode(chunk) {
    const float32 = new Float32Array(chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength));
    const output = this._output;
    queueMicrotask(() => {
      const FakeData = globalThis.__FakeAudioData;
      output(new FakeData({ numberOfFrames: float32.length, data: float32 }));
    });
  }
  close() {}
}

class FakeAudioData {
  constructor(opts) { this._opts = opts; }
  copyTo(buf) { buf.set(new Float32Array(this._opts.data)); }
  close() {}
  get numberOfFrames() { return this._opts.numberOfFrames; }
}

class FakeEncodedAudioChunk {
  constructor(opts) { this.data = new Uint8Array(opts.data); }
  copyTo(buf) { buf.set(this.data); }
  get byteLength() { return this.data.byteLength; }
}

beforeEach(() => {
  globalThis.AudioEncoder = FakeAudioEncoder;
  globalThis.AudioDecoder = FakeAudioDecoder;
  globalThis.AudioData = FakeAudioData;
  globalThis.EncodedAudioChunk = FakeEncodedAudioChunk;
  globalThis.__FakeAudioData = FakeAudioData;
  globalThis.__FakeEncodedAudioChunk = FakeEncodedAudioChunk;
});

// ─── createOpusEncoder tests ──────────────────────────────────────────────────
describe('createOpusEncoder', () => {
  it('returns an object with encode() and close() methods', () => {
    const enc = createOpusEncoder();
    expect(typeof enc.encode).toBe('function');
    expect(typeof enc.close).toBe('function');
    enc.close();
  });

  it('encode() returns a promise resolving to Uint8Array', async () => {
    const enc = createOpusEncoder();
    const samples = new Float32Array(960).fill(0.5);
    const result = await enc.encode(samples);
    expect(result).toBeInstanceOf(Uint8Array);
    enc.close();
  });

  it('encode() preserves sample data in pass-through (mock Opus)', async () => {
    const enc = createOpusEncoder();
    const samples = new Float32Array([0.1, 0.2, -0.3]);
    const result = await enc.encode(samples);
    const back = new Float32Array(result.buffer);
    expect(back[0]).toBeCloseTo(0.1, 5);
    expect(back[1]).toBeCloseTo(0.2, 5);
    expect(back[2]).toBeCloseTo(-0.3, 5);
    enc.close();
  });

  it('encode() resolves promises in order', async () => {
    const enc = createOpusEncoder();
    const p1 = enc.encode(new Float32Array([1]));
    const p2 = enc.encode(new Float32Array([2]));
    const r1 = await p1;
    const r2 = await p2;
    expect(new Float32Array(r1.buffer)[0]).toBe(1);
    expect(new Float32Array(r2.buffer)[0]).toBe(2);
    enc.close();
  });

  it('close() can be called multiple times without throwing', () => {
    const enc = createOpusEncoder();
    enc.close();
    expect(() => enc.close()).not.toThrow();
  });
});

// ─── createOpusDecoder tests ──────────────────────────────────────────────────
describe('createOpusDecoder', () => {
  it('returns an object with decode() and close() methods', () => {
    const dec = createOpusDecoder();
    expect(typeof dec.decode).toBe('function');
    expect(typeof dec.close).toBe('function');
    dec.close();
  });

  it('decode() returns a promise resolving to Float32Array', async () => {
    const dec = createOpusDecoder();
    const bytes = new Uint8Array(new Float32Array(960).fill(0.5).buffer);
    const result = await dec.decode(bytes);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(960);
    dec.close();
  });

  it('encoder→decoder round-trip preserves data', async () => {
    const enc = createOpusEncoder();
    const dec = createOpusDecoder();
    const original = new Float32Array([0.1, -0.5, 0.99, 0]);
    const encoded = await enc.encode(original);
    const decoded = await dec.decode(encoded);
    expect(decoded[0]).toBeCloseTo(0.1, 5);
    expect(decoded[1]).toBeCloseTo(-0.5, 5);
    expect(decoded[2]).toBeCloseTo(0.99, 5);
    expect(decoded[3]).toBeCloseTo(0, 5);
    enc.close();
    dec.close();
  });

  it('decode() resolves promises in order', async () => {
    const dec = createOpusDecoder();
    const d1 = dec.decode(new Uint8Array(new Float32Array([1]).buffer));
    const d2 = dec.decode(new Uint8Array(new Float32Array([2]).buffer));
    const r1 = await d1;
    const r2 = await d2;
    expect(r1[0]).toBe(1);
    expect(r2[0]).toBe(2);
    dec.close();
  });

  it('close() can be called multiple times without throwing', () => {
    const dec = createOpusDecoder();
    dec.close();
    expect(() => dec.close()).not.toThrow();
  });
});

// ─── createNoiseGate tests ────────────────────────────────────────────────────
describe('createNoiseGate', () => {
  it('outputs silence for silent input', () => {
    const g = createNoiseGate();
    const out = g.process(new Float32Array([0, 0, 0]));
    expect(Array.from(out)).toEqual([0, 0, 0]);
    expect(g.env).toBe(0);
    expect(g.isOpen).toBe(false);
  });

  it('passes a sustained loud signal through unchanged', () => {
    const g = createNoiseGate();
    const loud = new Float32Array([0.3, -0.3, 0.2]);
    let out;
    for (let i = 0; i < 30; i++) out = g.process(loud);
    expect(g.env).toBe(1);
    expect(Array.from(out)).toEqual(Array.from(loud));
  });

  it('ramps up gradually (attack smoothing) on first loud frame', () => {
    const g = createNoiseGate();
    const loud = new Float32Array([0.3, 0.3, 0.3]);
    const first = g.process(loud);
    expect(g.env).toBeCloseTo(0.08, 5);
    expect(first[0]).toBeCloseTo(0.3 * 0.08, 5);
  });

  it('keeps the gate open for signal between thresholds (hysteresis)', () => {
    const g = createNoiseGate();
    const loud = new Float32Array([0.3, 0.3, 0.3]);
    for (let i = 0; i < 30; i++) g.process(loud);
    const quiet = new Float32Array([0.01, 0.01, 0.01]);
    const out = g.process(quiet);
    expect(g.isOpen).toBe(true);
    expect(out[0]).toBeCloseTo(0.01, 5);
  });

  it('stays closed for signal below the close threshold', () => {
    const g = createNoiseGate();
    const out = g.process(new Float32Array([0.002, 0.002, 0.002]));
    expect(g.isOpen).toBe(false);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('reset() returns the gate to a closed state', () => {
    const g = createNoiseGate();
    const loud = new Float32Array([0.3, 0.3, 0.3]);
    for (let i = 0; i < 30; i++) g.process(loud);
    expect(g.env).toBe(1);
    g.reset();
    expect(g.env).toBe(0);
    expect(g.isOpen).toBe(false);
  });
});

describe('createNoiseGate: boundaries, release, custom opts', () => {
  it('opens only when peak strictly exceeds the open threshold', () => {
    const g = createNoiseGate();
    const openLin = Math.pow(10, -36 / 20);
    const below = g.process(new Float32Array([openLin * 0.99, openLin * 0.99, openLin * 0.99]));
    expect(g.isOpen).toBe(false);
    expect(Array.from(below)).toEqual([0, 0, 0]);
    const above = new Float32Array([openLin * 1.5, openLin * 1.5, openLin * 1.5]);
    let out;
    for (let i = 0; i < 30; i++) out = g.process(above);
    expect(g.isOpen).toBe(true);
    expect(g.env).toBe(1);
    expect(Array.from(out)).toEqual(Array.from(above));
  });

  it('closes only when peak strictly drops below the close threshold', () => {
    const g = createNoiseGate();
    const closeLin = Math.pow(10, -46 / 20);
    const above = g.process(new Float32Array([closeLin * 1.5, closeLin * 1.5, closeLin * 1.5]));
    expect(g.isOpen).toBe(false);
    expect(Array.from(above)).toEqual([0, 0, 0]);
    const below = new Float32Array([closeLin * 0.5, closeLin * 0.5, closeLin * 0.5]);
    const out = g.process(below);
    expect(g.isOpen).toBe(false);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('fades out gradually (release) once the signal drops', () => {
    const g = createNoiseGate({ openDb: -36, closeDb: -46, attack: 0.5, release: 0.5 });
    const loud = new Float32Array([0.3, 0.3, 0.3]);
    for (let i = 0; i < 30; i++) g.process(loud);
    expect(g.env).toBe(1);
    const quiet = new Float32Array([0, 0, 0]);
    const out1 = g.process(quiet);
    expect(g.isOpen).toBe(false);
    expect(g.env).toBeCloseTo(0.5, 5);
    expect(out1[0]).toBeCloseTo(0, 5);
    const out2 = g.process(quiet);
    expect(g.env).toBeCloseTo(0, 5);
    expect(Array.from(out2)).toEqual([0, 0, 0]);
  });

  it('scales a partially-open frame by the current env', () => {
    const g = createNoiseGate({ attack: 0.25, release: 0.25 });
    const loud = new Float32Array([0.3, 0.3, 0.3]);
    const first = g.process(loud);
    expect(g.env).toBeCloseTo(0.25, 5);
    expect(first[0]).toBeCloseTo(0.3 * 0.25, 5);
  });

  it('honours custom open/close/attack/release options', () => {
    const g = createNoiseGate({ openDb: -20, closeDb: -30, attack: 0.1, release: 0.9 });
    const mid = Math.pow(10, -25 / 20);
    const out = g.process(new Float32Array([mid, mid, mid]));
    expect(g.isOpen).toBe(false);
    expect(Array.from(out)).toEqual([0, 0, 0]);
    const loud = new Float32Array([0.5, 0.5, 0.5]);
    for (let i = 0; i < 30; i++) g.process(loud);
    expect(g.env).toBe(1);
  });

  it('handles an empty frame without throwing', () => {
    const g = createNoiseGate();
    expect(() => g.process(new Float32Array(0))).not.toThrow();
    expect(g.isOpen).toBe(false);
  });

  it('keeps the gate open while signal sits between the thresholds', () => {
    const g = createNoiseGate();
    const loud = new Float32Array([0.3, 0.3, 0.3]);
    for (let i = 0; i < 30; i++) g.process(loud);
    const between = new Float32Array([Math.pow(10, -40 / 20), 0, 0]);
    const out = g.process(between);
    expect(g.isOpen).toBe(true);
    expect(out[0]).toBeCloseTo(between[0], 5);
  });

  it('exposes env/isOpen getters that track internal state', () => {
    const g = createNoiseGate();
    expect(g.env).toBe(0);
    expect(g.isOpen).toBe(false);
    const loud = new Float32Array([0.4, 0.4, 0.4]);
    g.process(loud);
    expect(g.env).toBeGreaterThan(0);
    expect(g.isOpen).toBe(true);
    for (let i = 0; i < 30; i++) g.process(loud);
    expect(g.env).toBe(1);
    expect(g.isOpen).toBe(true);
  });
});
