// Pure codec + noise-gate tests (no browser APIs needed).
import { describe, it, expect } from 'vitest';
import { float32ToInt16, frameToBytes, int16ToFloat32, createNoiseGate } from '../audio-codec.js';

describe('float32ToInt16', () => {
  it('returns a little-endian Int16 ArrayBuffer of length*2', () => {
    const f = new Float32Array([0, 0.5, -0.25]);
    const buf = float32ToInt16(f);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe(6);
    const dv = new DataView(buf);
    expect(dv.getInt16(0, true)).toBe(0);
    expect(dv.getInt16(2, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(dv.getInt16(4, true)).toBe(Math.trunc(-0.25 * 0x8000));
  });

  it('clamps to the [-1, 1] range', () => {
    const dv = new DataView(float32ToInt16(new Float32Array([2, -2])));
    expect(dv.getInt16(0, true)).toBe(0x7fff);
    expect(dv.getInt16(2, true)).toBe(-0x8000);
  });

  it('handles an empty frame', () => {
    const buf = float32ToInt16(new Float32Array(0));
    expect(buf.byteLength).toBe(0);
  });

  it('clamps NaN to 0 and Infinity to the extremes', () => {
    const dv = new DataView(float32ToInt16(new Float32Array([NaN, Infinity, -Infinity])));
    expect(dv.getInt16(0, true)).toBe(0);          // NaN * 0x8000 -> NaN -> setInt16(NaN) -> 0
    expect(dv.getInt16(2, true)).toBe(0x7fff);     // +Infinity -> +1
    expect(dv.getInt16(4, true)).toBe(-0x8000);    // -Infinity -> -1
  });
});

describe('frameToBytes', () => {
  it('produces an Int16-le buffer for the wire', () => {
    const buf = frameToBytes(new Float32Array([1, -1]));
    const dv = new DataView(buf);
    expect(dv.getInt16(0, true)).toBe(0x7fff);
    expect(dv.getInt16(2, true)).toBe(-0x8000);
  });

  it('handles an empty frame', () => {
    const buf = frameToBytes(new Float32Array(0));
    expect(buf.byteLength).toBe(0);
  });

  it('is equivalent to float32ToInt16', () => {
    const f = new Float32Array([0.1, -0.2, 0.3]);
    const a = new Int16Array(frameToBytes(f));
    const b = new Int16Array(float32ToInt16(f));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('int16ToFloat32', () => {
  it('converts back to approximately the original floats', () => {
    const f = new Float32Array([0, 1, -1, 0.5]);
    const back = int16ToFloat32(float32ToInt16(f));
    expect(back[0]).toBeCloseTo(0, 5);
    expect(back[1]).toBeCloseTo(1 - 1 / 32768, 5);
    expect(back[2]).toBeCloseTo(-1, 5);
    expect(back[3]).toBeCloseTo(0.5, 2);
  });

  it('handles an empty ArrayBuffer', () => {
    expect(int16ToFloat32(new ArrayBuffer(0)).length).toBe(0);
  });

  it('round-trips a single sample', () => {
    const back = int16ToFloat32(float32ToInt16(new Float32Array([0.25])));
    expect(back[0]).toBeCloseTo(0.25, 4);
  });
});

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
    for (let i = 0; i < 30; i++) g.process(loud); // open it
    const quiet = new Float32Array([0.01, 0.01, 0.01]); // above close, below open
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
    // Just below the open threshold does NOT open (boundary is strict >).
    const below = g.process(new Float32Array([openLin * 0.99, openLin * 0.99, openLin * 0.99]));
    expect(g.isOpen).toBe(false);
    expect(Array.from(below)).toEqual([0, 0, 0]);
    // Just above the threshold opens (after a few frames the env reaches 1).
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
    // Just above the close threshold (but below open) does NOT close.
    const above = g.process(new Float32Array([closeLin * 1.5, closeLin * 1.5, closeLin * 1.5]));
    expect(g.isOpen).toBe(false);
    expect(Array.from(above)).toEqual([0, 0, 0]);
    // Below the close threshold stays closed.
    const below = new Float32Array([closeLin * 0.5, closeLin * 0.5, closeLin * 0.5]);
    const out = g.process(below);
    expect(g.isOpen).toBe(false);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('fades out gradually (release) once the signal drops', () => {
    const g = createNoiseGate({ openDb: -36, closeDb: -46, attack: 0.5, release: 0.5 });
    const loud = new Float32Array([0.3, 0.3, 0.3]);
    for (let i = 0; i < 30; i++) g.process(loud); // fully open
    expect(g.env).toBe(1);
    const quiet = new Float32Array([0, 0, 0]);
    const out1 = g.process(quiet);
    expect(g.isOpen).toBe(false);
    expect(g.env).toBeCloseTo(0.5, 5);
    expect(out1[0]).toBeCloseTo(0, 5); // env 0.5 * 0 = 0
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
    const mid = Math.pow(10, -25 / 20); // between -30 and -20 → stays closed from silent
    const out = g.process(new Float32Array([mid, mid, mid]));
    expect(g.isOpen).toBe(false);
    expect(Array.from(out)).toEqual([0, 0, 0]);
    // Now a loud signal (above -20) should open.
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
    for (let i = 0; i < 30; i++) g.process(loud); // open
    const between = new Float32Array([Math.pow(10, -40 / 20), 0, 0]); // above close, below open
    const out = g.process(between);
    expect(g.isOpen).toBe(true);
    expect(out[0]).toBeCloseTo(between[0], 5);
  });

  it('exposes env/isOpen getters that track internal state', () => {
    const g = createNoiseGate();
    expect(g.env).toBe(0);
    expect(g.isOpen).toBe(false);
    const loud = new Float32Array([0.4, 0.4, 0.4]);
    g.process(loud); // peak > open threshold → gate opens immediately
    expect(g.env).toBeGreaterThan(0);
    expect(g.isOpen).toBe(true);
    for (let i = 0; i < 30; i++) g.process(loud);
    expect(g.env).toBe(1);
    expect(g.isOpen).toBe(true);
  });
});
