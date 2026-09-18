// Tester: startar servern med en tillfällig databas i minnet.
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server');
const { openDb } = require('../db');

async function start() {
  const server = createServer(openDb(':memory:')).listen(0);
  const base = `http://localhost:${server.address().port}`;
  const api = async (path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { server, api };
}

test('/health svarar ok', async () => {
  const { server, api } = await start();
  const { status, data } = await api('/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(data.status, 'ok');
  server.close();
});

test('registrera, logga in och söka användare', async () => {
  const { server, api } = await start();
  const a = await api('/api/register', { body: { username: 'danik', displayName: 'Danik', password: 'hemligt1' } });
  assert.strictEqual(a.status, 201);
  await api('/api/register', { body: { username: 'vasja', displayName: 'Vasja', password: 'hemligt2' } });

  const dup = await api('/api/register', { body: { username: 'danik', displayName: 'X', password: 'hemligt3' } });
  assert.strictEqual(dup.status, 409);

  const bad = await api('/api/login', { body: { username: 'danik', password: 'fel' } });
  assert.strictEqual(bad.status, 401);

  const search = await api('/api/search?q=va', { token: a.data.token });
  assert.deepStrictEqual(search.data, [{ username: 'vasja', displayName: 'Vasja' }]);
  server.close();
});
