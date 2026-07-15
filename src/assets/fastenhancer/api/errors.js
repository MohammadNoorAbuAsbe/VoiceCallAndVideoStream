export class FastEnhancerError extends Error {
    code;
    constructor(message, options) {
        super(message, options);
        this.name = 'FastEnhancerError';
        this.code = 'FAST_ENHANCER_ERROR';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export class WasmLoadError extends FastEnhancerError {
    code = 'WASM_LOAD_FAILED';
    constructor(message, options) {
        super(message, options);
        this.name = 'WasmLoadError';
    }
}
export class ModelInitError extends FastEnhancerError {
    code = 'MODEL_INIT_FAILED';
    constructor(message, options) {
        super(message, options);
        this.name = 'ModelInitError';
    }
}
export class AudioContextError extends FastEnhancerError {
    code = 'AUDIO_CONTEXT_ERROR';
    constructor(message, options) {
        super(message, options);
        this.name = 'AudioContextError';
    }
}
export class WorkletError extends FastEnhancerError {
    code = 'WORKLET_ERROR';
    constructor(message, options) {
        super(message, options);
        this.name = 'WorkletError';
    }
}
export class ValidationError extends FastEnhancerError {
    code = 'VALIDATION_ERROR';
    constructor(message, options) {
        super(message, options);
        this.name = 'ValidationError';
    }
}
export class DestroyedError extends FastEnhancerError {
    code = 'DESTROYED_ERROR';
    constructor(message, options) {
        super(message, options);
        this.name = 'DestroyedError';
    }
}
//# sourceMappingURL=errors.js.map