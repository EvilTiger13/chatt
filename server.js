// Chattserver: konton, sök på användarnamn, privata chattar som sparas i databas.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { openDb } = require('./db');

const PORT = process.env.PORT || 3000;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createServer(db = openDb()) {
  const online = new Map(); // username -> Set av anslutna sockets

  const q = {
    getUser: db.prepare('SELECT * FROM users WHERE username = ?'),
    addUser: db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)'),
    addSession: db.prepare('INSERT INTO sessions VALUES (?, ?)'),
    getSession: db.prepare('SELECT username FROM sessions WHERE token = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    search: db.prepare(`SELECT username, display_name FROM users
                        WHERE username LIKE ? AND username != ? ORDER BY username LIMIT 10`),
    addMsg: db.prepare('INSERT INTO messages (sender, recipient, text, time) VALUES (?, ?, ?, ?)'),
    thread: db.prepare(`SELECT id, sender, recipient, text, time FROM messages
                        WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
                        ORDER BY id DESC LIMIT 200`),
    conversations: db.prepare(`
      SELECT u.username, u.display_name, m.text AS last_text, m.time AS last_time
      FROM (
        SELECT CASE WHEN sender = ? THEN recipient ELSE sender END AS other, MAX(id) AS last_id
        FROM messages WHERE sender = ? OR recipient = ? GROUP BY other
      ) c
      JOIN messages m ON m.id = c.last_id
      JOIN users u ON u.username = c.other
      ORDER BY m.id DESC`),
  };

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
  }

  function userFromToken(token) {
    const row = token && q.getSession.get(token);
    return row ? row.username : null;
  }

  function newSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    q.addSession.run(token, username);
    return token;
  }

  function publicUser(u) {
    return { username: u.username, displayName: u.display_name };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const me = userFromToken((req.headers.authorization || '').replace('Bearer ', ''));

    if (url.pathname === '/health') {
      return send(res, 200, { status: 'ok', uptime: process.uptime() });
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }

    if (url.pathname === '/api/register' && req.method === 'POST') {
      const { username = '', displayName = '', password = '' } = await readJson(req);
      const uname = String(username).trim().toLowerCase();
      const dname = String(displayName).trim().slice(0, 40);
      if (!USERNAME_RE.test(uname)) return send(res, 400, { error: 'Användarnamnet ska vara 3–20 tecken: a–z, 0–9 eller _' });
      if (!dname) return send(res, 400, { error: 'Skriv ditt namn' });
      if (String(password).length < 6) return send(res, 400, { error: 'Lösenordet ska vara minst 6 tecken' });
      if (q.getUser.get(uname)) return send(res, 409, { error: 'Användarnamnet är redan taget' });
      const salt = crypto.randomBytes(16).toString('hex');
      q.addUser.run(uname, dname, hashPassword(String(password), salt), salt, new Date().toISOString());
      return send(res, 201, { token: newSession(uname), user: { username: uname, displayName: dname } });
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { username = '', password = '' } = await readJson(req);
      const u = q.getUser.get(String(username).trim().toLowerCase());
      if (!u || hashPassword(String(password), u.salt) !== u.pass_hash) {
        return send(res, 401, { error: 'Fel användarnamn eller lösenord' });
      }
      return send(res, 200, { token: newSession(u.username), user: publicUser(u) });
    }

    if (url.pathname.startsWith('/api/') && !me) return send(res, 401, { error: 'Logga in först' });

    if (url.pathname === '/api/me') return send(res, 200, publicUser(q.getUser.get(me)));

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      q.delSession.run(req.headers.authorization.replace('Bearer ', ''));
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/search') {
      const term = String(url.searchParams.get('q') || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!term) return send(res, 200, []);
      return send(res, 200, q.search.all(term + '%', me).map(publicUser));
    }

    if (url.pathname === '/api/conversations') {
      return send(res, 200, q.conversations.all(me, me, me).map((c) => ({
        username: c.username, displayName: c.display_name, lastText: c.last_text, lastTime: c.last_time,
      })));
    }

    const m = url.pathname.match(/^\/api\/messages\/([a-z0-9_]+)$/);
    if (m) {
      const other = q.getUser.get(m[1]);
      if (!other) return send(res, 404, { error: 'Användaren finns inte' });
      return send(res, 200, {
        user: publicUser(other),
        messages: q.thread.all(me, other.username, other.username, me).reverse(),
      });
    }

    send(res, 404, { error: 'Not found' });
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    const me = userFromToken(token);
    if (!me) return socket.close(4001, 'unauthorized');

    if (!online.has(me)) online.set(me, new Set());
    online.get(me).add(socket);

    socket.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const to = String(data.to || '');
      const text = String(data.text || '').trim().slice(0, 2000);
      if (!text || to === me || !q.getUser.get(to)) return;

      const time = new Date().toISOString();
      const { lastInsertRowid } = q.addMsg.run(me, to, text, time);
      const msg = JSON.stringify({ type: 'message', id: Number(lastInsertRowid), sender: me, recipient: to, text, time });

      for (const user of [me, to]) {
        for (const s of online.get(user) || []) if (s.readyState === 1) s.send(msg);
      }
    });

    socket.on('close', () => {
      online.get(me)?.delete(socket);
      if (online.get(me)?.size === 0) online.delete(me);
    });
  });

  return server;
}

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`Chatt körs på http://localhost:${PORT}`));
}

module.exports = { createServer };
