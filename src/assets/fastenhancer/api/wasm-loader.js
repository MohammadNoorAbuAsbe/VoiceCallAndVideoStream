/**
 * wasm-loader.ts — WASM variant selection
 *
 * Chooses which WASM build to load, scalar or simd,
 * based on the SIMD detection result.
 *
 * Responsibility: variant selection only. Actual WASM loading is handled by Layer 1/2.
 */
/**
 * Selects a WASM variant based on SIMD support.
 *
 * @param simdSupported - SIMD detection result (return value of detectSimdSupport())
 * @returns The WASM variant to load
 */
export function selectWasmVariant(simdSupported) {
    return simdSupported ? 'simd' : 'scalar';
}
//# sourceMappingURL=wasm-loader.js.map