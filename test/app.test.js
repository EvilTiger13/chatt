// Tester: startar servern med en tillfällig databas och en låtsas-mejlserver.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require('../server');
const { openDb } = require('../db');

async function start() {
  const inbox = [];
  const mailer = { async send(to, subject, text) { inbox.push({ to, subject, text }); } };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatt-test-'));
  const server = createServer({ db: openDb(':memory:'), mailer, dataDir }).listen(0);
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  function client() {
    let cookie = '';
    const api = async (p, { body, method, raw, headers = {} } = {}) => {
      const res = await fetch(base + p, {
        method: method || (body || raw ? 'POST' : 'GET'),
        headers: { ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }), ...headers },
        body: raw || (body && JSON.stringify(body)),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
    };
    const socket = () => new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}`, { headers: { Cookie: cookie } });
      ws.inbox = [];
      ws.on('message', (m) => ws.inbox.push(JSON.parse(m)));
      ws.on('open', () => resolve(ws));
    });
    return { api, socket };
  }

  async function signup(c, username, email) {
    await c.api('/api/register', { body: { email, username, displayName: username.toUpperCase(), password: 'hemligt123' } });
    const code = inbox.filter((m) => m.to === email).at(-1).subject.match(/\d{6}/)[0];
    return c.api('/api/verify', { body: { email, code } });
  }

  const close = () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { base, client, signup, inbox, close };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('/health svarar ok', async () => {
  const t = await start();
  const { status, data } = await t.client().api('/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(data.status, 'ok');
  t.close();
});

test('registrering kräver e-postkod', async () => {
  const t = await start();
  const c = t.client();
  const reg = await c.api('/api/register', {
    body: { email: 'Danik@Example.se', username: 'danik', displayName: 'Danik', password: 'hemligt123' },
  });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(t.inbox.length, 1);
  assert.strictEqual(t.inbox[0].to, 'danik@example.se');

  const early = await c.api('/api/login', { body: { login: 'danik', password: 'hemligt123' } });
  assert.strictEqual(early.status, 403);
  assert.strictEqual(early.data.needsVerification, true);

  const wrong = await c.api('/api/verify', { body: { email: 'danik@example.se', code: '000000' } });
  assert.strictEqual(wrong.status, 400);

  const code = t.inbox[0].subject.match(/\d{6}/)[0];
  const ok = await c.api('/api/verify', { body: { email: 'danik@example.se', code } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.user.username, 'danik');

  const me = await c.api('/api/me');
  assert.strictEqual(me.data.email, 'danik@example.se');

  const c2 = t.client();
  const byEmail = await c2.api('/api/login', { body: { login: 'danik@example.se', password: 'hemligt123' } });
  assert.strictEqual(byEmail.status, 200);
  t.close();
});

test('sök, integritet och meddelanden i realtid', async () => {
  const t = await start();
  const a = t.client(), b = t.client();
  await t.signup(a, 'danik', 'danik@example.se');
  await t.signup(b, 'vasja', 'vasja@example.se');

  const found = await a.api('/api/search?q=va');
  assert.deepStrictEqual(found.data.map((u) => u.username), ['vasja']);

  await b.api('/api/me', { body: { settings: { searchable: false } } });
  assert.deepStrictEqual((await a.api('/api/search?q=va')).data, []);

  const wsA = await a.socket(), wsB = await b.socket();
  wsA.send(JSON.stringify({ type: 'send', to: 'vasja', text: 'Hej!' }));
  await wait(150);
  const got = wsB.inbox.find((m) => m.type === 'message');
  assert.strictEqual(got.message.text, 'Hej!');

  wsB.send(JSON.stringify({ type: 'read', peer: 'danik' }));
  await wait(150);
  assert.ok(wsA.inbox.some((m) => m.type === 'read' && m.by === 'vasja'));

  wsA.send(JSON.stringify({ type: 'edit', id: got.message.id, text: 'Hej igen!' }));
  await wait(150);
  const upd = wsB.inbox.find((m) => m.type === 'update');
  assert.strictEqual(upd.message.text, 'Hej igen!');
  assert.strictEqual(upd.message.edited, true);

  const convos = await b.api('/api/conversations');
  assert.strictEqual(convos.data[0].username, 'danik');
  wsA.close(); wsB.close();
  t.close();
});

test('filer syns bara för dem i chatten', async () => {
  const t = await start();
  const a = t.client(), b = t.client(), c = t.client();
  await t.signup(a, 'danik', 'danik@example.se');
  await t.signup(b, 'vasja', 'vasja@example.se');
  await t.signup(c, 'petja', 'petja@example.se');

  const up = await a.api('/api/upload', {
    raw: 'hej fil', headers: { 'Content-Type': 'text/plain', 'X-Filename': encodeURIComponent('anteckning.txt') },
  });
  assert.strictEqual(up.status, 201);

  const wsA = await a.socket();
  wsA.send(JSON.stringify({ type: 'send', to: 'vasja', kind: 'file', fileId: up.data.id }));
  await wait(150);

  assert.strictEqual((await b.api(`/files/${up.data.id}`)).status, 200);
  assert.strictEqual((await c.api(`/files/${up.data.id}`)).status, 404);
  wsA.close();
  t.close();
});

test('samtal blockeras enligt integritetsinställning', async () => {
  const t = await start();
  const a = t.client(), b = t.client();
  await t.signup(a, 'danik', 'danik@example.se');
  await t.signup(b, 'vasja', 'vasja@example.se');
  await b.api('/api/me', { body: { settings: { callsFrom: 'nobody' } } });

  const wsA = await a.socket(), wsB = await b.socket();
  wsA.send(JSON.stringify({ type: 'call-offer', to: 'vasja', callId: 'x1', sdp: 'v=0', video: true }));
  await wait(150);
  assert.ok(wsA.inbox.some((m) => m.type === 'call-unavailable' && m.reason === 'privacy'));
  assert.ok(!wsB.inbox.some((m) => m.type === 'call-offer'));

  await b.api('/api/me', { body: { settings: { callsFrom: 'everyone' } } });
  wsA.send(JSON.stringify({ type: 'call-offer', to: 'vasja', callId: 'x2', sdp: 'v=0', video: true }));
  await wait(150);
  const offer = wsB.inbox.find((m) => m.type === 'call-offer');
  assert.strictEqual(offer.from, 'danik');
  assert.strictEqual(offer.caller.displayName, 'DANIK');
  wsA.close(); wsB.close();
  t.close();
});
