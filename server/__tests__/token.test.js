// Token-gated relay: RELAY_TOKEN is read from process.env at module load, so we
// import a FRESH copy of the server (cache-busted query) with the token set.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebSocket } from 'ws';

let mod;
let port;
let baseUrl;
const created = [];

beforeAll(async () => {
  process.env.RELAY_TOKEN = 'topsecret';
  mod = await import('../server.js?token=' + Date.now());
  port = await mod.startServer(0);
  baseUrl = `ws://127.0.0.1:${port}`;
});
afterAll(async () => {
  await mod.stopServer();
  delete process.env.RELAY_TOKEN;
});
afterEach(() => {
  for (const c of created) { try { c.close(); } catch { /* noop */ } }
  created.length = 0;
});

function client() {
  const ws = new WebSocket(baseUrl);
  const c = {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    open: () => new Promise((res, rej) => { ws.on('open', () => res(c)); ws.on('error', rej); }),
    waitFor: (type, timeout = 5000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout ' + type)), timeout);
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.t === type) { clearTimeout(t); res(m); }
      });
    }),
    close: () => ws.close(),
  };
  created.push(c);
  return c;
}

it('denies registration without the token', async () => {
  const c = client();
  await c.open();
  c.send({ t: 'register', id: 'no-token' });
  const denied = await c.waitFor('register-denied');
  expect(denied.t).toBe('register-denied');
});

it('allows registration with the correct token', async () => {
  const c = client();
  await c.open();
  c.send({ t: 'register', id: 'with-token', token: 'topsecret' });
  const reg = await c.waitFor('registered');
  expect(reg.id).toBe('with-token');
});

it('denies registration with a wrong token', async () => {
  const c = client();
  await c.open();
  c.send({ t: 'register', id: 'wrong-token', token: 'nope' });
  const denied = await c.waitFor('register-denied');
  expect(denied.t).toBe('register-denied');
});
