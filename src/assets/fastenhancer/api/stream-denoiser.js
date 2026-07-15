/**
 * stream-denoiser.ts — AudioWorklet-integrated Layer 2 API
 *
 * Accepts a MediaStream input, performs WASM noise removal inside AudioWorklet,
 * and outputs a cleaned MediaStream.
 *
 * Responsibility: manages AudioContext/AudioWorklet/MediaStream connections only.
 * The details of WASM inference are handled by processor.js on the worklet side.
 */
import { DestroyedError, AudioContextError, WorkletError, ValidationError } from './errors.js';
import { initProcessorBlobUrl } from './embedded-loader.js';
/** Sample rate expected by the model (Hz) */
const TARGET_SAMPLE_RATE = 48000;
/** Maximum time to wait for Worklet initialization to complete (ms) */
const WORKLET_INIT_TIMEOUT_MS = 10_000;
/** Maximum time to wait for Worklet state retrieval (ms) */
const WORKLET_STATE_TIMEOUT_MS = 500;
/**
 * Creates a stream denoiser that performs real-time noise removal through AudioWorklet.
 */
export async function createStreamDenoiser(options) {
    const { inputStream, wasmBytes, weightBytes, exportMap, modelSize, workletUrl, audioContext: injectedAudioContext, onWarning, } = options;
    const VALID_MODEL_SIZES = [0, 1, 2];
    if (!VALID_MODEL_SIZES.includes(modelSize)) {
        throw new ValidationError(`Invalid modelSize: ${modelSize}. Must be 0 (tiny), 1 (base), or 2 (small).`);
    }
    const emitWarning = (message) => {
        try {
            onWarning?.(message);
        }
        catch (_) {
            // User callback error must not propagate
        }
    };
    const _ownsAudioContext = injectedAudioContext === undefined;
    let audioContext = injectedAudioContext;
    if (_ownsAudioContext) {
        try {
            audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
        }
        catch (err) {
            throw new AudioContextError(`Failed to create AudioContext: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const closeOwnedAudioContext = async (context, contextLabel) => {
        if (!_ownsAudioContext || context.state === 'closed') {
            return;
        }
        try {
            await context.close();
        }
        catch (resumeErr) {
            emitWarning(`${contextLabel}: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`);
        }
    };
    if (audioContext.state === 'suspended') {
        try {
            await audioContext.resume();
        }
        catch (resumeErr) {
            await closeOwnedAudioContext(audioContext, 'AudioContext.close() failed after resume error');
            throw new AudioContextError(`AudioContext.resume() failed (possibly due to autoplay restrictions): ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`);
        }
    }
    if (audioContext.sampleRate !== TARGET_SAMPLE_RATE) {
        emitWarning(`AudioContext sample rate is ${audioContext.sampleRate}Hz (expected: ${TARGET_SAMPLE_RATE}Hz).` +
            ` Audio quality may be reduced.`);
    }
    let processorUrl;
    try {
        processorUrl = workletUrl ?? await initProcessorBlobUrl();
    }
    catch (err) {
        await closeOwnedAudioContext(audioContext, 'AudioContext.close() failed');
        throw err;
    }
    try {
        await audioContext.audioWorklet.addModule(processorUrl);
    }
    catch (err) {
        await closeOwnedAudioContext(audioContext, 'AudioContext.close() failed');
        const errMsg = err instanceof Error ? err.message : String(err);
        const usedBlobUrl = processorUrl.startsWith('blob:') || processorUrl.startsWith('data:');
        const cspHint = usedBlobUrl
            ? ' If your Content Security Policy blocks blob: or data: URLs,' +
                ' provide a static processor.js URL via the workletUrl option,' +
                ' or add "blob:" to your worker-src CSP directive.'
            : '';
        throw new WorkletError(`Failed to register AudioWorklet: ${errMsg}${cspHint}`);
    }
    let workletNode;
    let source;
    let destination;
    try {
        workletNode = new AudioWorkletNode(audioContext, 'fastenhancer-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        source = audioContext.createMediaStreamSource(inputStream);
        destination = audioContext.createMediaStreamDestination();
        source.connect(workletNode);
        workletNode.connect(destination);
    }
    catch (err) {
        // @ts-expect-error — partial construction: variables may be uninitialized
        if (source) {
            try {
                source.disconnect();
            }
            catch (_) { /* noop */ }
        }
        // @ts-expect-error — partial construction: variables may be uninitialized
        if (workletNode) {
            try {
                workletNode.disconnect();
            }
            catch (_) { /* noop */ }
        }
        // @ts-expect-error — partial construction: variables may be uninitialized
        if (destination) {
            destination.stream.getTracks().forEach((t) => { try {
                t.stop();
            }
            catch (_) { /* noop */ } });
        }
        void closeOwnedAudioContext(audioContext, 'AudioContext.close() failed');
        throw new WorkletError(`Failed to construct AudioWorklet node: ${err instanceof Error ? err.message : String(err)}`);
    }
    const initPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            workletNode.port.removeEventListener('message', handler);
            reject(new WorkletError(`Worklet initialization timed out (${WORKLET_INIT_TIMEOUT_MS / 1000}s)`));
        }, WORKLET_INIT_TIMEOUT_MS);
        const handler = (event) => {
            if (event.data?.type === 'ready') {
                clearTimeout(timeout);
                workletNode.port.removeEventListener('message', handler);
                resolve();
            }
            else if (event.data?.type === 'error') {
                clearTimeout(timeout);
                workletNode.port.removeEventListener('message', handler);
                reject(new WorkletError(`Worklet initialization failed: ${event.data.message ?? 'Unknown error'}`));
            }
        };
        workletNode.port.addEventListener('message', handler);
        workletNode.port.start();
    });
    const wasmBytesTransfer = wasmBytes.slice(0);
    const weightBytesTransfer = weightBytes.slice(0);
    workletNode.port.postMessage({
        type: 'init',
        wasmBytes: wasmBytesTransfer,
        weightBytes: weightBytesTransfer,
        exportMap,
        modelSize,
    }, [wasmBytesTransfer, weightBytesTransfer]);
    try {
        await initPromise;
    }
    catch (err) {
        try {
            source.disconnect();
        }
        catch (e) {
            emitWarning(`source.disconnect() failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
            workletNode.disconnect();
        }
        catch (e) {
            emitWarning(`workletNode.disconnect() failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        destination.stream.getTracks().forEach((track) => {
            try {
                track.stop();
            }
            catch (e) {
                emitWarning(`MediaStreamTrack.stop() failed during init cleanup: ${e instanceof Error ? e.message : String(e)}`);
            }
        });
        await closeOwnedAudioContext(audioContext, 'AudioContext.close() failed');
        throw err;
    }
    let currentState = 'running';
    let bypassMode = false;
    let autoPassthroughMode = false;
    let agcMode = false;
    let hpfMode = false;
    let destroyPromise = null;
    const workletMessageHandler = (event) => {
        if (event.data?.type === 'process_error' && currentState !== 'destroyed') {
            emitWarning(`Worklet processing error: ${event.data.message ?? 'Unknown'}`);
            return;
        }
        if (event.data?.type === 'auto_bypass' && currentState !== 'destroyed') {
            autoPassthroughMode = Boolean(event.data.enabled);
            try {
                options.onAutoBypass?.(autoPassthroughMode);
            }
            catch (_) {
                // User callback error must not propagate into worklet message handler
            }
        }
    };
    const audioContextStateChangeHandler = () => {
        const nextState = audioContext.state;
        emitWarning(`AudioContext state changed to "${nextState}".`);
        if (nextState === 'suspended' && currentState !== 'destroyed' && _ownsAudioContext) {
            void audioContext.resume().catch((resumeErr) => {
                emitWarning(`AudioContext.resume() failed after suspension: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`);
            });
            return;
        }
        if (nextState === 'closed') {
            currentState = 'destroyed';
            try {
                options.onDestroy?.();
            }
            catch (_) {
                // User callback error must not propagate
            }
        }
    };
    workletNode.port.addEventListener('message', workletMessageHandler);
    audioContext.addEventListener('statechange', audioContextStateChangeHandler);
    const denoiser = {
        get outputStream() {
            return destination.stream;
        },
        get state() {
            return currentState;
        },
        get bypass() {
            return bypassMode;
        },
        set bypass(value) {
            if (currentState === 'destroyed') {
                throw new DestroyedError('This StreamDenoiser has already been destroyed');
            }
            bypassMode = value;
            workletNode.port.postMessage({ type: 'set_bypass', enabled: value });
        },
        get autoPassthrough() {
            return autoPassthroughMode;
        },
        get agcEnabled() {
            return agcMode;
        },
        set agcEnabled(value) {
            if (currentState === 'destroyed') {
                throw new DestroyedError('This StreamDenoiser has already been destroyed');
            }
            agcMode = value;
            workletNode.port.postMessage({ type: 'set_agc', enabled: value });
        },
        get hpfEnabled() {
            return hpfMode;
        },
        set hpfEnabled(value) {
            if (currentState === 'destroyed') {
                throw new DestroyedError('This StreamDenoiser has already been destroyed');
            }
            hpfMode = value;
            workletNode.port.postMessage({ type: 'set_hpf', enabled: value });
        },
        destroy() {
            void this.destroyAsync().catch((e) => {
                emitWarning(`destroyAsync() failed: ${e instanceof Error ? e.message : String(e)}`);
            });
        },
        async destroyAsync() {
            if (destroyPromise) {
                return destroyPromise;
            }
            destroyPromise = (async () => {
                currentState = 'destroyed';
                audioContext.removeEventListener('statechange', audioContextStateChangeHandler);
                workletNode.port.removeEventListener('message', workletMessageHandler);
                try {
                    source.disconnect();
                }
                catch (e) {
                    emitWarning(`source.disconnect() failed during destroy: ${e instanceof Error ? e.message : String(e)}`);
                }
                try {
                    workletNode.disconnect();
                }
                catch (e) {
                    emitWarning(`workletNode.disconnect() failed during destroy: ${e instanceof Error ? e.message : String(e)}`);
                }
                const destroyAckTimeout = 2000;
                const ackPromise = new Promise((resolve) => {
                    let settled = false;
                    const cleanup = () => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        clearTimeout(timer);
                        workletNode.port.removeEventListener('message', handler);
                    };
                    const handler = (event) => {
                        if (event.data?.type === 'destroyed' || event.data?.type === 'error') {
                            cleanup();
                            resolve();
                        }
                    };
                    const timer = setTimeout(() => {
                        cleanup();
                        resolve();
                    }, destroyAckTimeout);
                    workletNode.port.addEventListener('message', handler);
                });
                try {
                    workletNode.port.postMessage({ type: 'destroy' });
                }
                catch (e) {
                    emitWarning(`workletNode.port.postMessage() failed during destroy: ${e instanceof Error ? e.message : String(e)}`);
                }
                destination.stream.getTracks().forEach((track) => {
                    try {
                        track.stop();
                    }
                    catch (e) {
                        emitWarning(`MediaStreamTrack.stop() failed during destroy: ${e instanceof Error ? e.message : String(e)}`);
                    }
                });
                await ackPromise;
                try {
                    workletNode.port.close();
                }
                catch (e) {
                    emitWarning(`workletNode.port.close() failed during destroy: ${e instanceof Error ? e.message : String(e)}`);
                }
                await closeOwnedAudioContext(audioContext, 'AudioContext.close() failed during destroy');
            })();
            return destroyPromise;
        },
        getWorkletState() {
            if (currentState === 'destroyed') {
                return Promise.reject(new DestroyedError('This StreamDenoiser has already been destroyed'));
            }
            const requestId = `state_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    workletNode.port.removeEventListener('message', handler);
                    reject(new WorkletError(`Worklet state retrieval timed out (${WORKLET_STATE_TIMEOUT_MS / 1000}s)`));
                }, WORKLET_STATE_TIMEOUT_MS);
                const handler = (event) => {
                    if (event.data?.type === 'state' && event.data?.requestId === requestId) {
                        clearTimeout(timeout);
                        workletNode.port.removeEventListener('message', handler);
                        resolve(event.data);
                    }
                };
                workletNode.port.addEventListener('message', handler);
                workletNode.port.start();
                workletNode.port.postMessage({ type: 'get_state', requestId });
            });
        },
    };
    return denoiser;
}
//# sourceMappingURL=stream-denoiser.js.map