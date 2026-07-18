# VoiceCall Relay Server

A tiny WebSocket relay used by VoiceCall to forward call signaling and audio
between two peers. Because clients only make **outbound** WebSocket connections,
no ICE / TURN / WebRTC NAT traversal is needed — it works behind any firewall.

## Run locally

```bash
cd server
npm install
npm start
# listens on :3000 (set PORT to change)
```

## Deploy (free tiers)

The server is a single Node process with one dependency (`ws`). Deploy it
anywhere that gives you a public `wss://` URL:

- **Fly.io** — `fly launch` + `fly deploy` (the included `npm start` works).
- **Render** — "Web Service", build `npm install`, start `npm start`.
- **Railway / Koyeb / any Node host** — same.

Make sure the host terminates TLS so clients can use `wss://`.

### Pick the region closest to your callers (biggest latency lever)

Every audio frame makes **two** WebSocket hops through this server
(client → relay → peer), so the relay's region dominates talk-latency.
Pick the region nearest the *midpoint* between you and the people you call:

- Render regions: **Oregon**, **Ohio**, **Virginia**, **Frankfurt**, **Singapore**.
- e.g. callers in Israel / Europe → deploy in **Frankfurt** (not the default
  Oregon). Then update `DEFAULT_RELAY_URL` in `src/main.js` to the new
  `wss://…` URL, or paste it into the app's **Settings → Relay Server URL**.

### Keep a free instance awake (avoid cold-start latency)

Render's free tier spins the instance down after ~15 min of inactivity, so the
first call after a lull can take several seconds to connect (and the post-idle
CPU ramp briefly inflates in-call latency). For always-on, low-jitter audio,
use a paid **Starter** instance, or keep the free tier warm with a free uptime
monitor (UptimeRobot / Pingdom) that hits `https://<your-app>.onrender.com/healthz`
every ~5 minutes.

## Optional access token

Set `RELAY_TOKEN` on the server. Clients must then register with the same
token (set it in the app's Settings → Relay). Leave unset for open access
(fine for personal/friends use).

```bash
RELAY_TOKEN=some-secret PORT=3000 node server.js
```

## Wire it to the app

After deploying, copy the `wss://…` URL and paste it into the app:
**Settings → Relay Server URL**. (You can also bake a default into
`DEFAULT_RELAY_URL` in `src/main.js` so users never have to set it.)
