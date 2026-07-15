# VoiceCallAndVideoStream

A peer-to-peer voice call app (Tauri desktop) that uses a **self-hosted WebSocket
relay** instead of WebRTC/ICE/TURN. Because clients only open outbound
WebSocket connections, calls work behind any NAT or firewall with no
traversal setup.

## How it works

- Each user has a persistent ID (stored locally, shared with contacts like a
  phone number).
- A small relay server (`server/`) maps IDs → sockets and forwards:
  - call signaling (`call` / `accept` / `busy` / `hangup` / `reconnect` …)
  - raw 16 kHz PCM audio frames (mic → relay → peer)
- The app captures the mic via Web Audio, optionally runs RNNoise noise
  cancellation, downsamples to 16 kHz, and streams PCM over the WebSocket.
  Received PCM is played through a worklet. No media server, no TURN.

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
- RNNoise noise cancellation (toggleable, with raw-mic fallback)
- Mute (with global keybind) and per-call remote-mute indicator
- Microphone / speaker device selection
