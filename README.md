# VoiceCallAndVideoStream

A peer-to-peer voice call app (Tauri desktop) that uses a **self-hosted WebSocket
relay** instead of WebRTC/ICE/TURN. Because clients only open outbound
WebSocket connections, calls work behind any NAT or firewall with no
traversal setup.

## How it works

- Each user has a persistent ID (stored locally, shared with contacts like a
  phone number). The ID is the fingerprint of your Ed25519 public key, so it is
  unforgeable — see [Security](#security).
- A small relay server (`server/`) maps IDs → sockets and forwards:
  - call signaling (`call` / `accept` / `busy` / `hangup` / `reconnect` …)
  - end-to-end-encrypted 16 kHz PCM audio frames (mic → relay → peer). The relay
    only ever sees ciphertext.
- The app captures the mic via Web Audio, optionally runs FastEnhancer DTLN
  noise cancellation, downsamples to 16 kHz, encrypts each frame, and streams it
  over the WebSocket. Received frames are decrypted and played through a
  worklet. No media server, no TURN.

## Run the relay

```bash
cd server
npm install
npm start          # listens on :3000 (set PORT to change)
```

Deploy `server/` anywhere that gives a public `wss://` URL (Fly.io, Render,
Railway, …). See `server/README.md`. Optionally set `RELAY_TOKEN` to lock it
down.

## Run the app

```bash
npm run tauri dev        # dev
npm run tauri build      # release bundle
```

In the app: **Settings → Relay Server URL** → paste your `wss://…` URL. (You
can also bake a default into `DEFAULT_RELAY_URL` in `src/main.js`.)

## Features

- One-click calling once IDs are shared
- Busy detection ("Friend is busy") and simultaneous-call (glare) handling
- Automatic reconnect on dropped connections (with backoff)
- FastEnhancer DTLN noise cancellation (toggleable, with raw-mic fallback)
- Mute (with global keybind) and per-call remote-mute indicator
- Microphone / speaker device selection

## Security

- **Unforgeable identity.** Your peer ID is the fingerprint (SHA-256) of your
  Ed25519 public key. Registration requires signing a server-issued challenge,
  so only the holder of the matching private key can register (or reclaim) that
  ID. A second session with the same key is treated as a reconnect; a different
  key claiming an already-online ID is rejected.
- **End-to-end encryption.** Every call performs an ephemeral X25519 key
  exchange. The caller's offer (and the callee's answer) carry the identity
  public key plus an ephemeral key, all signed and verified against the peer's
  fingerprint, so neither key can be swapped. The shared secret is run through
  HKDF and split into per-direction AES-GCM keys. The relay only forwards
  ciphertext — it cannot decrypt audio and cannot impersonate either party.
- **No plaintext at rest or in transit.** Private keys live only in
  `localStorage`. Audio frames are encrypted on the device before they leave,
  and call `name`s are local-only contact labels that are never transmitted.
  Mute state is sent in cleartext by design (it is not sensitive).
