// Chatt – server: konton med e-postverifiering, profiler, privata chattar,
// filer, röstmeddelanden och signalering för röst-/videosamtal (WebRTC).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { openDb } = require('./db');
const { createMailer } = require('./mailer');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const LIMITS = {
  json: 100 * 1024,
  upload: 25 * 1024 * 1024,
  avatar: 5 * 1024 * 1024,
  text: 4000,
};
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_DAYS = 30;
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|audio\/[\w.+-]+|video\/(mp4|webm))$/;
const AVATAR_TYPES = /^image\/(png|jpeg|gif|webp)$/;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

// ---------- Hjälpfunktioner ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https';
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return Promise.reject(new HttpError(415, 'Förväntade JSON'));
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
      if (raw.length > LIMITS.json) { reject(new HttpError(413, 'För stor förfrågan')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new HttpError(400, 'Ogiltig JSON')); } });
    req.on('error', reject);
  });
}

// Enkel spärr mot för många försök (per IP och åtgärd).
function createRateLimiter() {
  const hits = new Map();
  return (key, max, windowMs) => {
    const t = Date.now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    list.push(t);
    hits.set(key, list);
    if (list.length > max) throw new HttpError(429, 'För många försök. Vänta en stund och försök igen.');
  };
}

function createServer({ db, mailer, dataDir = DATA_DIR } = {}) {
  db = db || openDb(process.env.DB_PATH || path.join(dataDir, 'chatt.db'));
  mailer = mailer || createMailer();
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const limit = createRateLimiter();
  const online = new Map(); // username -> Set<socket>

  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  }

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    addUser: db.prepare(`INSERT INTO users (username, email, display_name, pass_hash, salt, created_at)
                         VALUES (?, ?, ?, ?, ?, ?)`),
    delUser: db.prepare('DELETE FROM users WHERE username = ?'),
    cleanupUnverified: db.prepare('DELETE FROM users WHERE verified = 0 AND created_at < ?'),
    setCode: db.prepare('UPDATE users SET code_hash = ?, code_expires = ?, code_attempts = 0, code_sent_at = ? WHERE username = ?'),
    codeAttempt: db.prepare('UPDATE users SET code_attempts = code_attempts + 1 WHERE username = ?'),
    verify: db.prepare('UPDATE users SET verified = 1, code_hash = NULL, code_expires = NULL WHERE username = ?'),
    updateProfile: db.prepare(`UPDATE users SET display_name = ?, bio = ?, searchable = ?, calls_from = ?, read_receipts = ?
                               WHERE username = ?`),
    setPassword: db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE username = ?'),
    setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE username = ?'),

    addSession: db.prepare('INSERT INTO sessions VALUES (?, ?, ?)'),
    session: db.prepare('SELECT username, created_at FROM sessions WHERE token = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    delOtherSessions: db.prepare('DELETE FROM sessions WHERE username = ? AND token != ?'),

    search: db.prepare(`SELECT * FROM users WHERE verified = 1 AND searchable = 1
                        AND username LIKE ? ESCAPE '\\' AND username != ? ORDER BY username LIMIT 15`),

    addFile: db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)'),
    file: db.prepare('SELECT * FROM files WHERE id = ?'),
    delFile: db.prepare('DELETE FROM files WHERE id = ?'),
    fileVisible: db.prepare(`SELECT 1 FROM messages WHERE file_id = ? AND (sender = ? OR recipient = ?) LIMIT 1`),

    addMsg: db.prepare(`INSERT INTO messages (sender, recipient, kind, text, file_id, reply_to, time)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`),
    msg: db.prepare('SELECT * FROM messages WHERE id = ?'),
    editMsg: db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?'),
    deleteMsg: db.prepare('UPDATE messages SET deleted = 1, text = NULL, file_id = NULL WHERE id = ?'),
    markRead: db.prepare(`UPDATE messages SET read_at = ? WHERE sender = ? AND recipient = ? AND read_at IS NULL`),
    thread: db.prepare(`SELECT * FROM messages
                        WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) AND id < ?
                        ORDER BY id DESC LIMIT 60`),
    hasContact: db.prepare(`SELECT 1 FROM messages WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?) LIMIT 1`),
    conversations: db.prepare(`
      SELECT c.other, c.last_id,
        (SELECT COUNT(*) FROM messages u WHERE u.sender = c.other AND u.recipient = ? AND u.read_at IS NULL AND u.deleted = 0) AS unread
      FROM (
        SELECT CASE WHEN sender = ? THEN recipient ELSE sender END AS other, MAX(id) AS last_id
        FROM messages WHERE sender = ? OR recipient = ? GROUP BY other
      ) c ORDER BY c.last_id DESC`),
  };

  // ---------- Presentation av data ----------
  function avatarUrl(u) {
    return u.avatar ? `/avatars/${u.username}?v=${u.avatar.slice(0, 8)}` : null;
  }
  function publicUser(u) {
    return { username: u.username, displayName: u.display_name, bio: u.bio, avatar: avatarUrl(u) };
  }
  function privateUser(u) {
    return {
      ...publicUser(u),
      email: u.email,
      settings: { searchable: !!u.searchable, callsFrom: u.calls_from, readReceipts: !!u.read_receipts },
    };
  }
  function fileOut(id) {
    const f = id && q.file.get(id);
    return f ? { id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/files/${f.id}` } : null;
  }
  function receiptsOn(a, b) {
    const ua = q.userByName.get(a), ub = q.userByName.get(b);
    return !!(ua && ub && ua.read_receipts && ub.read_receipts);
  }
  function preview(m) {
    if (!m) return null;
    if (m.deleted) return 'Meddelandet raderades';
    if (m.kind === 'image') return '📷 Bild' + (m.text ? ': ' + m.text : '');
    if (m.kind === 'voice') return '🎤 Röstmeddelande';
    if (m.kind === 'file') return '📎 ' + (fileOut(m.file_id)?.name || 'Fil');
    return m.text;
  }
  function msgOut(m, showRead) {
    const reply = m.reply_to ? q.msg.get(m.reply_to) : null;
    return {
      id: Number(m.id), sender: m.sender, recipient: m.recipient, kind: m.kind,
      text: m.deleted ? null : m.text,
      file: m.deleted ? null : fileOut(m.file_id),
      replyTo: reply ? { id: Number(reply.id), sender: reply.sender, preview: preview(reply) } : null,
      edited: !!m.edited_at, deleted: !!m.deleted, time: m.time,
      read: !!(showRead && m.read_at),
    };
  }

  // ---------- Sessioner ----------
  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    const s = q.session.get(token);
    if (!s) return null;
    if (Date.now() - Date.parse(s.created_at) > SESSION_DAYS * 864e5) { q.delSession.run(token); return null; }
    const u = q.userByName.get(s.username);
    return u && u.verified ? u : null;
  }
  function sessionCookie(req, token, maxAge) {
    return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (isHttps(req) ? '; Secure' : '');
  }
  function startSession(req, res, username, body) {
    const token = crypto.randomBytes(32).toString('hex');
    q.addSession.run(token, username, now());
    send(res, 200, body, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  // ---------- Verifieringskod via e-post ----------
  async function sendCode(user) {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    q.setCode.run(sha256(code + user.salt), Date.now() + CODE_TTL_MS, Date.now(), user.username);
    try {
      await mailer.send(user.email, `Din kod till Chatt: ${code}`,
        `Hej ${user.display_name}!\n\nDin verifieringskod är: ${code}\n\nKoden gäller i 15 minuter.\n` +
        `Om du inte har skapat ett konto kan du ignorera det här mejlet.`);
    } catch (err) {
      console.error('Kunde inte skicka e-post:', err.message);
      throw new HttpError(502, 'Kunde inte skicka e-post. Försök igen om en stund.');
    }
  }

  // ---------- Filer ----------
  function saveUpload(req, owner, maxBytes, allowed) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > maxBytes) return reject(new HttpError(413, `Filen är för stor (max ${Math.round(maxBytes / 1048576)} MB)`));
      let mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) mime = 'application/octet-stream';
      if (allowed && !allowed.test(mime)) return reject(new HttpError(415, 'Filtypen stöds inte'));
      let name = 'fil';
      try { name = decodeURIComponent(String(req.headers['x-filename'] || 'fil')); } catch {}
      name = name.replace(/[\\/\0<>:"|?*\r\n]/g, '_').slice(0, 120) || 'fil';

      const id = crypto.randomBytes(16).toString('hex');
      const dest = path.join(uploadDir, id);
      const out = fs.createWriteStream(dest);
      let size = 0, failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true; out.destroy(); fs.rm(dest, { force: true }, () => {}); reject(err);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { fail(new HttpError(413, 'Filen är för stor')); req.destroy(); }
      });
      req.on('error', fail);
      out.on('error', fail);
      req.pipe(out);
      out.on('finish', () => {
        if (failed) return;
        if (size === 0) return fail(new HttpError(400, 'Tom fil'));
        q.addFile.run(id, owner, name, mime, size, now());
        resolve({ id, name, mime, size });
      });
    });
  }
  function removeFile(id) {
    if (!id) return;
    q.delFile.run(id);
    fs.rm(path.join(uploadDir, id), { force: true }, () => {});
  }
  function serveFile(req, res, f) {
    const file = path.join(uploadDir, f.id);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Filen finns inte längre' });
    const inline = INLINE_TYPES.test(f.mime);
    res.writeHead(200, {
      'Content-Type': inline ? f.mime : 'application/octet-stream',
      'Content-Length': f.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
  }

  // ---------- HTTP-rutter ----------
  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = clientIp(req);

    if (p === '/health') return send(res, 200, { status: 'ok', uptime: process.uptime() });

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
    }

    // --- Registrering och inloggning ---
    if (p === '/api/register' && req.method === 'POST') {
      limit('register:' + ip, 10, 3600e3);
      const b = await readJson(req);
      const email = String(b.email || '').trim().toLowerCase();
      const username = String(b.username || '').trim().toLowerCase();
      const displayName = String(b.displayName || '').trim().slice(0, 40);
      const password = String(b.password || '');
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Ange en giltig e-postadress');
      if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Användarnamnet ska vara 3–20 tecken: a–z, 0–9 eller _');
      if (!displayName) throw new HttpError(400, 'Skriv ditt namn');
      if (password.length < 8) throw new HttpError(400, 'Lösenordet ska vara minst 8 tecken');

      q.cleanupUnverified.run(new Date(Date.now() - 864e5).toISOString());
      const byEmail = q.userByEmail.get(email);
      if (byEmail?.verified) throw new HttpError(409, 'Det finns redan ett konto med den e-postadressen');
      const byName = q.userByName.get(username);
      if (byName && byName.email !== email) throw new HttpError(409, 'Användarnamnet är redan taget');
      if (byEmail) q.delUser.run(byEmail.username);

      const salt = crypto.randomBytes(16).toString('hex');
      q.addUser.run(username, email, displayName, hashPassword(password, salt), salt, now());
      await sendCode(q.userByName.get(username));
      return send(res, 201, { needsVerification: true, email });
    }

    if (p === '/api/verify' && req.method === 'POST') {
      limit('verify:' + ip, 30, 600e3);
      const b = await readJson(req);
      const u = q.userByEmail.get(String(b.email || '').trim().toLowerCase());
      const code = String(b.code || '').replace(/\D/g, '');
      if (!u || u.verified || !u.code_hash) throw new HttpError(400, 'Ingen kod väntar för den här e-postadressen');
      if (u.code_attempts >= CODE_MAX_ATTEMPTS) throw new HttpError(429, 'För många fel försök. Begär en ny kod.');
      if (Date.now() > u.code_expires) throw new HttpError(400, 'Koden har gått ut. Begär en ny kod.');
      if (!safeEqual(sha256(code + u.salt), u.code_hash)) {
        q.codeAttempt.run(u.username);
        throw new HttpError(400, 'Fel kod');
      }
      q.verify.run(u.username);
      return startSession(req, res, u.username, { user: privateUser(q.userByName.get(u.username)) });
    }

    if (p === '/api/resend' && req.method === 'POST') {
      limit('resend:' + ip, 10, 3600e3);
      const b = await readJson(req);
      const u = q.userByEmail.get(String(b.email || '').trim().toLowerCase());
      if (u && !u.verified) {
        if (u.code_sent_at && Date.now() - u.code_sent_at < CODE_RESEND_MS) {
          throw new HttpError(429, 'Vänta en minut innan du begär en ny kod');
        }
        await sendCode(u);
      }
      return send(res, 200, { ok: true });
    }

    if (p === '/api/login' && req.method === 'POST') {
      limit('login:' + ip, 20, 600e3);
      const b = await readJson(req);
      const login = String(b.login || '').trim().toLowerCase();
      const u = login.includes('@') ? q.userByEmail.get(login) : q.userByName.get(login);
      if (!u || !safeEqual(hashPassword(String(b.password || ''), u.salt), u.pass_hash)) {
        throw new HttpError(401, 'Fel användarnamn/e-post eller lösenord');
      }
      if (!u.verified) {
        if (!u.code_sent_at || Date.now() - u.code_sent_at > CODE_RESEND_MS) await sendCode(u);
        throw new HttpError(403, 'Bekräfta din e-post först. Vi har skickat en kod.', { needsVerification: true, email: u.email });
      }
      return startSession(req, res, u.username, { user: privateUser(u) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const token = parseCookies(req.headers.cookie).sid;
      if (token) q.delSession.run(token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    // --- Allt nedanför kräver inloggning ---
    const me = currentUser(req);
    if (!me && (p.startsWith('/api/') || p.startsWith('/files/') || p.startsWith('/avatars/'))) {
      throw new HttpError(401, 'Logga in först');
    }

    if (p === '/api/config') return send(res, 200, { iceServers });

    if (p === '/api/me' && req.method === 'GET') return send(res, 200, privateUser(me));

    if (p === '/api/me' && req.method === 'POST') {
      const b = await readJson(req);
      const s = b.settings || {};
      const displayName = String(b.displayName ?? me.display_name).trim().slice(0, 40);
      if (!displayName) throw new HttpError(400, 'Namnet får inte vara tomt');
      const callsFrom = ['everyone', 'contacts', 'nobody'].includes(s.callsFrom) ? s.callsFrom : me.calls_from;
      q.updateProfile.run(
        displayName,
        String(b.bio ?? me.bio).trim().slice(0, 200),
        s.searchable === undefined ? me.searchable : (s.searchable ? 1 : 0),
        callsFrom,
        s.readReceipts === undefined ? me.read_receipts : (s.readReceipts ? 1 : 0),
        me.username,
      );
      return send(res, 200, privateUser(q.userByName.get(me.username)));
    }

    if (p === '/api/me/password' && req.method === 'POST') {
      limit('password:' + me.username, 10, 600e3);
      const b = await readJson(req);
      if (!safeEqual(hashPassword(String(b.current || ''), me.salt), me.pass_hash)) throw new HttpError(400, 'Nuvarande lösenord stämmer inte');
      if (String(b.next || '').length < 8) throw new HttpError(400, 'Det nya lösenordet ska vara minst 8 tecken');
      const salt = crypto.randomBytes(16).toString('hex');
      q.setPassword.run(hashPassword(String(b.next), salt), salt, me.username);
      q.delOtherSessions.run(me.username, parseCookies(req.headers.cookie).sid);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/me/avatar' && req.method === 'POST') {
      const f = await saveUpload(req, me.username, LIMITS.avatar, AVATAR_TYPES);
      removeFile(me.avatar);
      q.setAvatar.run(f.id, me.username);
      return send(res, 200, privateUser(q.userByName.get(me.username)));
    }

    if (p === '/api/me/avatar' && req.method === 'DELETE') {
      removeFile(me.avatar);
      q.setAvatar.run(null, me.username);
      return send(res, 200, privateUser(q.userByName.get(me.username)));
    }

    if (p === '/api/search') {
      const term = String(url.searchParams.get('q') || '').toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_/g, '\\_');
      if (!term) return send(res, 200, []);
      return send(res, 200, q.search.all(term + '%', me.username).map(publicUser));
    }

    const userMatch = p.match(/^\/api\/users\/([a-z0-9_]+)$/);
    if (userMatch) {
      const u = q.userByName.get(userMatch[1]);
      if (!u || !u.verified) throw new HttpError(404, 'Användaren finns inte');
      return send(res, 200, publicUser(u));
    }

    if (p === '/api/conversations') {
      const rows = q.conversations.all(me.username, me.username, me.username, me.username);
      return send(res, 200, rows.map((r) => {
        const u = q.userByName.get(r.other);
        const last = q.msg.get(r.last_id);
        return {
          ...publicUser(u),
          lastText: preview(last),
          lastMine: last.sender === me.username,
          lastTime: last.time,
          unread: r.unread,
        };
      }));
    }

    const threadMatch = p.match(/^\/api\/messages\/([a-z0-9_]+)$/);
    if (threadMatch) {
      const other = q.userByName.get(threadMatch[1]);
      if (!other || !other.verified) throw new HttpError(404, 'Användaren finns inte');
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const showRead = receiptsOn(me.username, other.username);
      const rows = q.thread.all(me.username, other.username, other.username, me.username, before);
      return send(res, 200, {
        user: publicUser(other),
        messages: rows.reverse().map((m) => msgOut(m, showRead)),
        hasMore: rows.length === 60,
      });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      limit('upload:' + me.username, 60, 600e3);
      return send(res, 201, await saveUpload(req, me.username, LIMITS.upload));
    }

    const fileMatch = p.match(/^\/files\/([a-f0-9]{32})$/);
    if (fileMatch) {
      const f = q.file.get(fileMatch[1]);
      if (!f || (f.owner !== me.username && !q.fileVisible.get(f.id, me.username, me.username))) {
        throw new HttpError(404, 'Filen finns inte');
      }
      return serveFile(req, res, f);
    }

    const avatarMatch = p.match(/^\/avatars\/([a-z0-9_]+)$/);
    if (avatarMatch) {
      const u = q.userByName.get(avatarMatch[1]);
      const f = u?.avatar && q.file.get(u.avatar);
      if (!f) throw new HttpError(404, 'Ingen profilbild');
      return serveFile(req, res, f);
    }

    throw new HttpError(404, 'Hittades inte');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      console.error(err);
      send(res, 500, { error: 'Serverfel' });
    });
  });

  // ---------- WebSocket: meddelanden i realtid och samtalssignalering ----------
  const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

  function emit(username, payload) {
    const data = JSON.stringify(payload);
    for (const s of online.get(username) || []) if (s.readyState === 1) s.send(data);
  }
  function emitOthers(username, except, payload) {
    const data = JSON.stringify(payload);
    for (const s of online.get(username) || []) if (s !== except && s.readyState === 1) s.send(data);
  }
  function broadcastMessage(m) {
    const showRead = receiptsOn(m.sender, m.recipient);
    const out = msgOut(m, showRead);
    emit(m.sender, { type: 'message', message: out });
    if (m.recipient !== m.sender) emit(m.recipient, { type: 'message', message: out });
  }
  function broadcastUpdate(m) {
    const out = msgOut(m, receiptsOn(m.sender, m.recipient));
    emit(m.sender, { type: 'update', message: out });
    emit(m.recipient, { type: 'update', message: out });
  }

  const handlers = {
    send(me, d) {
      const to = q.userByName.get(String(d.to || ''));
      if (!to || !to.verified || to.username === me) return;
      const kind = ['text', 'image', 'file', 'voice'].includes(d.kind) ? d.kind : 'text';
      const text = String(d.text || '').trim().slice(0, LIMITS.text) || null;
      let fileId = null;
      if (kind !== 'text') {
        const f = q.file.get(String(d.fileId || ''));
        if (!f || f.owner !== me) return;
        fileId = f.id;
      } else if (!text) return;
      let replyTo = null;
      if (d.replyTo) {
        const r = q.msg.get(Number(d.replyTo));
        const sameChat = r && ((r.sender === me && r.recipient === to.username) || (r.sender === to.username && r.recipient === me));
        if (sameChat) replyTo = r.id;
      }
      const { lastInsertRowid } = q.addMsg.run(me, to.username, kind, text, fileId, replyTo, now());
      broadcastMessage(q.msg.get(lastInsertRowid));
    },
    edit(me, d) {
      const m = q.msg.get(Number(d.id));
      const text = String(d.text || '').trim().slice(0, LIMITS.text);
      if (!m || m.sender !== me || m.deleted) return;
      if (!text && m.kind === 'text') return;
      q.editMsg.run(text || null, now(), m.id);
      broadcastUpdate(q.msg.get(m.id));
    },
    delete(me, d) {
      const m = q.msg.get(Number(d.id));
      if (!m || m.sender !== me || m.deleted) return;
      const fileId = m.file_id;
      q.deleteMsg.run(m.id);
      removeFile(fileId);
      broadcastUpdate(q.msg.get(m.id));
    },
    typing(me, d) {
      const to = String(d.to || '');
      if (to !== me) emit(to, { type: 'typing', from: me });
    },
    read(me, d) {
      const peer = String(d.peer || '');
      const { changes } = q.markRead.run(now(), peer, me);
      if (changes > 0) {
        emit(me, { type: 'read-self', peer });
        if (receiptsOn(me, peer)) emit(peer, { type: 'read', by: me });
      }
    },
  };

  // Samtal: servern skickar bara vidare signaler mellan två användare (själva ljudet/videon går direkt mellan dem).
  function relayCall(me, socket, d) {
    const to = q.userByName.get(String(d.to || ''));
    if (!to || to.username === me) return;
    const base = { from: me, callId: String(d.callId || '').slice(0, 64) };

    if (d.type === 'call-offer') {
      const blocked = to.calls_from === 'nobody' ||
        (to.calls_from === 'contacts' && !q.hasContact.get(me, to.username, to.username, me));
      if (blocked) return socket.send(JSON.stringify({ type: 'call-unavailable', ...base, reason: 'privacy' }));
      if (!online.has(to.username)) return socket.send(JSON.stringify({ type: 'call-unavailable', ...base, reason: 'offline' }));
      const caller = q.userByName.get(me);
      return emit(to.username, {
        type: 'call-offer', ...base, video: !!d.video, sdp: String(d.sdp || '').slice(0, 20000),
        caller: publicUser(caller),
      });
    }
    if (d.type === 'call-answer') {
      emitOthers(me, socket, { type: 'call-handled', callId: base.callId });
      return emit(to.username, { type: 'call-answer', ...base, sdp: String(d.sdp || '').slice(0, 20000) });
    }
    if (d.type === 'call-reject' || d.type === 'call-busy') {
      emitOthers(me, socket, { type: 'call-handled', callId: base.callId });
      return emit(to.username, { type: d.type, ...base });
    }
    if (d.type === 'call-end') return emit(to.username, { type: 'call-end', ...base });
    if (d.type === 'ice') {
      const c = d.candidate || {};
      return emit(to.username, {
        type: 'ice', ...base,
        candidate: { candidate: String(c.candidate || '').slice(0, 1000), sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null },
      });
    }
  }

  wss.on('connection', (socket, req) => {
    const user = currentUser(req);
    if (!user) return socket.close(4001, 'unauthorized');
    const me = user.username;
    if (!online.has(me)) online.set(me, new Set());
    online.get(me).add(socket);

    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', (raw) => {
      let d;
      try { d = JSON.parse(raw); } catch { return; }
      if (!d || typeof d.type !== 'string') return;
      try {
        if (d.type.startsWith('call-') || d.type === 'ice') relayCall(me, socket, d);
        else if (handlers[d.type]) handlers[d.type](me, d);
      } catch (err) { console.error('WS-fel:', err); }
    });

    socket.on('close', () => {
      const set = online.get(me);
      set?.delete(socket);
      if (set?.size === 0) online.delete(me);
    });
  });

  // Rensa döda anslutningar (t.ex. mobiler som tappat nätet).
  const heartbeat = setInterval(() => {
    for (const s of wss.clients) {
      if (!s.isAlive) { s.terminate(); continue; }
      s.isAlive = false;
      s.ping();
    }
  }, 30000);
  server.on('close', () => clearInterval(heartbeat));

  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Chatt körs på http://localhost:${PORT}`);
    if (!process.env.SMTP_HOST) console.log('E-post: utvecklingsläge – verifieringskoder skrivs ut här i terminalen.');
  });
}

module.exports = { createServer };
