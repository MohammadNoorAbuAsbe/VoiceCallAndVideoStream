# Graph Report - .  (2026-07-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 477 nodes · 744 edges · 40 communities (33 shown, 7 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.57)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5ed9b3e7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- main.js
- loader.js
- server.js
- RelayClient
- main.test.js
- audio.js
- package.json
- tauri.conf.json
- FakeRelayClient
- audio.test.js
- loadEmbeddedExportMap
- embedded-loader.js
- package.json
- player-worklet.test.js
- default.json
- activations.js
- compression.js
- fft.js
- capture-worklet.test.js
- wasm-base-scalar.js
- wasm-base-simd.js
- wasm-small-scalar.js
- wasm-small-simd.js
- wasm-tiny-scalar.js
- wasm-tiny-simd.js
- weights-base.js
- weights-small.js
- weights-tiny.js
- conv.js
- CaptureProcessor
- graphify.js
- token.test.js
- gru.js

## God Nodes (most connected - your core abstractions)
1. `RelayClient` - 19 edges
2. `FakeRelayClient` - 17 edges
3. `initRelay()` - 17 edges
4. `showScreen()` - 14 edges
5. `showToast()` - 12 edges
6. `acceptIncomingInternal()` - 11 edges
7. `loadEmbeddedWasm()` - 10 edges
8. `loadEmbeddedExportMap()` - 10 edges
9. `renderContacts()` - 9 edges
10. `startCall()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `loadModelViaEmbed()` --calls--> `loadEmbeddedExportMap()`  [EXTRACTED]
  src/assets/fastenhancer/api/loader.js → src/assets/fastenhancer/api/embedded-loader.js
- `createStreamDenoiser()` --calls--> `initProcessorBlobUrl()`  [EXTRACTED]
  src/assets/fastenhancer/api/stream-denoiser.js → src/assets/fastenhancer/api/embedded-loader.js
- `isSupported()` --calls--> `detectSimdSupport()`  [EXTRACTED]
  src/assets/fastenhancer/api/index.js → src/assets/fastenhancer/api/simd-detect.js
- `initCapture()` --calls--> `loadModel()`  [EXTRACTED]
  src/audio.js → src/assets/fastenhancer/api/loader.js
- `capture48ToWire()` --calls--> `frameToBytes()`  [EXTRACTED]
  src/audio.js → src/audio-codec.js

## Import Cycles
- None detected.

## Communities (40 total, 7 thin omitted)

### Community 0 - "main.js"
Cohesion: 0.08
Nodes (59): acceptCall(), acceptIncomingInternal(), applyOutputDevice(), cancelCall(), clearReconnectUI(), copyMyId(), enableSoundTapped(), endCallCleanup() (+51 more)

### Community 1 - "loader.js"
Cohesion: 0.06
Nodes (47): detectSimd(), diagnose(), revokeProcessorBlobUrl(), AudioContextError, DestroyedError, FastEnhancerError, ModelInitError, ValidationError (+39 more)

### Community 2 - "server.js"
Cohesion: 0.11
Nodes (21): rec, attachRelay(), calls, clients, endCall(), handleAudio(), handleClose(), handleMessage() (+13 more)

### Community 3 - "RelayClient"
Cohesion: 0.11
Nodes (4): RelayClient, connected(), firstWs(), MockWebSocket

### Community 4 - "main.test.js"
Cohesion: 0.08
Nodes (12): bodyMatch, __dirname, html, HTML_PATH, setInput(), setupDom(), FakeAudioCtx, FakeGain (+4 more)

### Community 5 - "audio.js"
Cohesion: 0.13
Nodes (9): capture48ToWire(), createNoiseGate(), float32ToInt16(), frameToBytes(), int16ToFloat32(), initCapture(), noiseGate, playBytes() (+1 more)

### Community 6 - "package.json"
Cohesion: 0.09
Nodes (21): fastenhancer-web, jsdom, devDependencies, fastenhancer-web, jsdom, @tauri-apps/cli, vitest, @vitest/coverage-v8 (+13 more)

### Community 7 - "tauri.conf.json"
Cohesion: 0.11
Nodes (18): icons/128x128@2x.png, icons/128x128.png, icons/32x32.png, icons/icon.ico, app, security, withGlobalTauri, build (+10 more)

### Community 9 - "audio.test.js"
Cohesion: 0.11
Nodes (7): captureWith(), ctxInstances, FakeAudioContext, FakeNode, FakeParam, makeDenoiser(), workletNodes

### Community 10 - "loadEmbeddedExportMap"
Cohesion: 0.15
Nodes (7): loadEmbeddedExportMap(), exportMap, exportMap, exportMap, exportMap, exportMap, exportMap

### Community 11 - "embedded-loader.js"
Cohesion: 0.22
Nodes (12): _createBlobUrl(), ensureProcessorSourceLoaded(), getProcessorBlobUrl(), initProcessorBlobUrl(), loadEmbeddedWasm(), loadEmbeddedWeights(), VALID_MODELS, VALID_VARIANTS (+4 more)

### Community 12 - "package.json"
Cohesion: 0.18
Nodes (10): dependencies, ws, description, name, private, scripts, start, type (+2 more)

### Community 13 - "player-worklet.test.js"
Cohesion: 0.20
Nodes (3): PlayerProcessor, drain(), FakeProcessor

### Community 14 - "default.json"
Cohesion: 0.22
Nodes (8): core:default, main, opener:default, description, identifier, permissions, $schema, windows

### Community 15 - "activations.js"
Cohesion: 0.32
Nodes (6): _expBuffer, _expView, fastExp(), polynomialSigmoid(), sigmoid(), silu()

### Community 16 - "compression.js"
Cohesion: 0.61
Nodes (7): applyComplexMask(), clampMagnitude(), clampSigned(), isFiniteNum(), powerCompress(), powerDecompress(), sanitize()

### Community 17 - "fft.js"
Cohesion: 0.53
Nodes (4): bitReverse(), fft(), ifft(), reverseBits()

### Community 19 - "wasm-base-scalar.js"
Cohesion: 0.67
Nodes (3): _decode(), getWasmBytes(), _LUT

### Community 20 - "wasm-base-simd.js"
Cohesion: 0.67
Nodes (3): _decode(), getWasmBytes(), _LUT

### Community 21 - "wasm-small-scalar.js"
Cohesion: 0.67
Nodes (3): _decode(), getWasmBytes(), _LUT

### Community 22 - "wasm-small-simd.js"
Cohesion: 0.67
Nodes (3): _decode(), getWasmBytes(), _LUT

### Community 23 - "wasm-tiny-scalar.js"
Cohesion: 0.67
Nodes (3): _decode(), getWasmBytes(), _LUT

### Community 24 - "wasm-tiny-simd.js"
Cohesion: 0.67
Nodes (3): _decode(), getWasmBytes(), _LUT

### Community 25 - "weights-base.js"
Cohesion: 0.67
Nodes (3): _decode(), getWeightData(), _LUT

### Community 26 - "weights-small.js"
Cohesion: 0.67
Nodes (3): _decode(), getWeightData(), _LUT

### Community 27 - "weights-tiny.js"
Cohesion: 0.67
Nodes (3): _decode(), getWeightData(), _LUT

## Knowledge Gaps
- **84 isolated node(s):** `rec`, `name`, `private`, `version`, `type` (+79 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `loadModel()` connect `loader.js` to `audio.test.js`, `audio.js`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `loadEmbeddedWasm()` connect `embedded-loader.js` to `loader.js`, `wasm-base-scalar.js`, `wasm-base-simd.js`, `wasm-small-scalar.js`, `wasm-small-simd.js`, `wasm-tiny-scalar.js`, `wasm-tiny-simd.js`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Why does `RelayClient` connect `RelayClient` to `main.js`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **What connects `rec`, `name`, `private` to the rest of the system?**
  _84 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `main.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07605633802816901 - nodes in this community are weakly interconnected._
- **Should `loader.js` be split into smaller, more focused modules?**
  _Cohesion score 0.062003968253968256 - nodes in this community are weakly interconnected._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10795454545454546 - nodes in this community are weakly interconnected._