/**
 * Power compression/decompression + complex mask application module
 * (TypeScript reference implementation)
 * Pure TypeScript implementation equivalent to the C engine's compression.c.
 */
const COMPRESS_EXP = 0.3;
const MAX_MAGNITUDE = 1e10;
const MAG_FLOOR = 1e-5;
function isFiniteNum(x) {
    return x === x && x !== Infinity && x !== -Infinity;
}
function sanitize(x) {
    return isFiniteNum(x) ? x : 0.0;
}
function clampMagnitude(x) {
    if (!isFiniteNum(x))
        return 0.0;
    if (x > MAX_MAGNITUDE)
        return MAX_MAGNITUDE;
    if (x < 0.0)
        return 0.0;
    return x;
}
function clampSigned(x) {
    if (!isFiniteNum(x))
        return 0.0;
    if (x > MAX_MAGNITUDE)
        return MAX_MAGNITUDE;
    if (x < -MAX_MAGNITUDE)
        return -MAX_MAGNITUDE;
    return x;
}
/**
 * Power compression: complex number (re, im) → compressed (mag^0.3, phase)
 */
export function powerCompress(re, im) {
    const safeRe = sanitize(re);
    const safeIm = sanitize(im);
    const rawMag = Math.sqrt(safeRe * safeRe + safeIm * safeIm);
    const mag = clampMagnitude(rawMag);
    const phase = Math.atan2(safeIm, safeRe);
    return {
        mag: mag < MAG_FLOOR ? 0.0 : sanitize(Math.pow(mag, COMPRESS_EXP)),
        phase: sanitize(phase),
    };
}
/**
 * Power decompression: (compressedMag, phase) → original complex number (re, im)
 * compressedMag = originalMag^0.3, so originalMag = compressedMag^(1/0.3)
 */
export function powerDecompress(compressedMag, phase) {
    const safeMag = clampMagnitude(compressedMag);
    const safePhase = sanitize(phase);
    if (safeMag <= 0.0)
        return { real: 0, imag: 0 };
    const originalMag = clampMagnitude(Math.pow(safeMag, 1.0 / COMPRESS_EXP));
    const real = clampSigned(sanitize(originalMag * Math.cos(safePhase)));
    const imag = clampSigned(sanitize(originalMag * Math.sin(safePhase)));
    return {
        real,
        imag,
    };
}
/**
 * Apply complex mask (complex multiplication)
 * (inRe + inIm*i) * (maskRe + maskIm*i)
 */
export function applyComplexMask(inRe, inIm, maskRe, maskIm) {
    const sInRe = sanitize(inRe);
    const sInIm = sanitize(inIm);
    const sMaskRe = sanitize(maskRe);
    const sMaskIm = sanitize(maskIm);
    return {
        real: clampSigned(sInRe * sMaskRe - sInIm * sMaskIm),
        imag: clampSigned(sInRe * sMaskIm + sInIm * sMaskRe),
    };
}
//# sourceMappingURL=compression.js.map