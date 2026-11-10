'use strict';
/*
 * Live Quiz - Vercel edition.
 * One Vercel Function serving the HTTP API and the WebSocket (Socket.IO) connections.
 * Static pages (public/) are served by Vercel's CDN:
 *   Player site:      /
 *   Quiz master site: /host
 * All configuration comes from environment variables - no secrets in code.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');
const games = require('../lib/games');

const ON_VERCEL = !!process.env.VERCEL;
const USE_BLOB = !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const PORT = parseInt(process.env.PORT, 10) || 3000;
const LOCAL_UPLOADS = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ---------- quiz master password + signed session cookie ----------
let HOST_PASSWORD = process.env.HOST_PASSWORD || '';
if (!HOST_PASSWORD && !ON_VERCEL) {
  HOST_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.log('HOST_PASSWORD is not set. Temporary quiz master password: ' + HOST_PASSWORD);
}
const PASSWORD_OK = HOST_PASSWORD.length >= 8;
const SESSION_KEY = crypto.createHash('sha256').update('lq-session:' + (process.env.SESSION_SECRET || HOST_PASSWORD)).digest();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (v) => crypto.createHmac('sha256', SESSION_KEY).update(v).digest('hex');

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* ignore */ } }
  });
  return out;
}
function sessionValid(cookieHeader) {
  if (!PASSWORD_OK) return false;
  const token = parseCookies(cookieHeader).qm_session || '';
  const [exp, mac] = token.split('.');
  if (!exp || !mac || !/^\d+$/.test(exp)) return false;
  return safeEqual(mac, sign(exp)) && Number(exp) > Date.now();
}
function requireHost(req, res, next) {
  if (sessionValid(req.headers.cookie)) return next();
  res.status(401).json({ error: 'Please log in' });
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: /REDIS_URL/.test(e.message) ? e.message : 'Server error, please try again' });
});

// ---------- quiz validation ----------
const IMAGE_RE = USE_BLOB
  ? /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/quiz-images\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/
  : /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

function cleanQuiz(body) {
  if (!body || typeof body !== 'object') throw new Error('Invalid quiz');
  const title = String(body.title || '').trim().slice(0, 100);
  if (!title) throw new Error('The quiz needs a title');
  if (!Array.isArray(body.questions) || body.questions.length < 1) throw new Error('Add at least one question');
  if (body.questions.length > 100) throw new Error('Maximum 100 questions');
  const questions = body.questions.map((q, i) => {
    const n = i + 1;
    const text = String((q && q.text) || '').trim().slice(0, 300);
    const image = String((q && q.image) || '');
    if (image && !IMAGE_RE.test(image)) throw new Error(`Question ${n}: invalid image`);
    if (!text && !image) throw new Error(`Question ${n}: add question text or an image`);
    if (!q || !Array.isArray(q.options)) throw new Error(`Question ${n}: options missing`);
    const options = q.options.map((o) => String(o || '').trim().slice(0, 120));
    if (options.length < 2 || options.length > 4) throw new Error(`Question ${n}: needs 2 to 4 options`);
    if (options.some((o) => !o)) throw new Error(`Question ${n}: fill in every option (or remove empty ones)`);
    const correct = Number(q.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new Error(`Question ${n}: choose the correct answer`);
    let time = parseInt(q.time, 10);
    if (!Number.isFinite(time)) time = 20;
    time = Math.min(120, Math.max(5, time));
    return { text, image, options, correct, time };
  });
  return { title, questions };
}

// ---------- Express (all API routes live under /api) ----------
const app = express();
app.set('trust proxy', ON_VERCEL || process.env.TRUST_PROXY === '1');
app.disable('x-powered-by');

const CSP = "default-src 'self'; img-src 'self' data: blob: https://*.public.blob.vercel-storage.com; style-src 'self'; " +
  "script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
app.use((req, res, next) => { // on Vercel the same headers are also set for static pages in vercel.json
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  if (req.url.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '300kb' }));

app.post('/api/host/login', wrap(async (req, res) => {
  if (!PASSWORD_OK) return res.status(500).json({ error: 'Set the HOST_PASSWORD environment variable (8+ characters) and redeploy.' });
  const ip = req.ip;
  if (await games.limited('login:' + ip, 10)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!safeEqual(password, HOST_PASSWORD)) {
    await games.countHit('login:' + ip, 15 * 60);
    return res.status(401).json({ error: 'Wrong password' });
  }
  const exp = String(Date.now() + SESSION_TTL_MS);
  const secure = ON_VERCEL || req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `qm_session=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  res.json({ ok: true });
}));

app.post('/api/host/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'qm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/host/me', (req, res) => res.json({ loggedIn: sessionValid(req.headers.cookie) }));

app.get('/api/quizzes', requireHost, wrap(async (req, res) => res.json(await games.listQuizzes())));

app.post('/api/quizzes', requireHost, wrap(async (req, res) => {
  let clean;
  try { clean = cleanQuiz(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const existing = req.body.id ? await games.getQuiz(req.body.id) : null;
  const now = new Date().toISOString();
  const quiz = { id: existing ? existing.id : crypto.randomBytes(8).toString('hex'), ...clean, createdAt: existing ? existing.createdAt : now, updatedAt: now };
  await games.saveQuiz(quiz);
  res.json(quiz);
}));

async function removeImage(url) {
  try {
    if (USE_BLOB) { const { del } = require('@vercel/blob'); await del(url); }
    else await fs.promises.unlink(path.join(LOCAL_UPLOADS, path.basename(url)));
  } catch (e) { console.error('Image delete failed:', e.message); }
}

app.delete('/api/quizzes/:id', requireHost, wrap(async (req, res) => {
  const quiz = await games.getQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Not found' });
  await games.deleteQuiz(quiz.id);
  const stillUsed = new Set((await games.listQuizzes()).flatMap((q) => q.questions.map((x) => x.image)));
  const unused = new Set(quiz.questions.map((q) => q.image).filter((u) => u && IMAGE_RE.test(u) && !stillUsed.has(u)));
  await Promise.all([...unused].map(removeImage));
  res.json({ ok: true });
}));

// Image upload. Vercel limits request bodies to 4.5 MB, so we cap at 4 MB (the browser shrinks photos first).
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (MIME_EXT[file.mimetype] ? cb(null, true) : cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed'))),
});
function looksLikeImage(b) {
  return (
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
    b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    b.slice(0, 4).toString() === 'GIF8' ||
    (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP')
  );
}

app.post('/api/upload', requireHost, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 4 MB)' : err.message });
      if (!req.file) return res.status(400).json({ error: 'No image received' });
      if (req.file.size < 12 || !looksLikeImage(req.file.buffer)) return res.status(400).json({ error: 'That file is not a valid image' });
      // random name; the user's file name is never used
      const name = crypto.randomBytes(16).toString('hex') + '.' + MIME_EXT[req.file.mimetype];
      if (USE_BLOB) {
        const { put } = require('@vercel/blob');
        const blob = await put('quiz-images/' + name, req.file.buffer, { access: 'public', contentType: req.file.mimetype, addRandomSuffix: false });
        return res.json({ url: blob.url });
      }
      if (ON_VERCEL) return res.status(500).json({ error: 'No image storage connected. Add a Vercel Blob store (public) to this project and redeploy.' });
      await fs.promises.mkdir(LOCAL_UPLOADS, { recursive: true });
      await fs.promises.writeFile(path.join(LOCAL_UPLOADS, name), req.file.buffer);
      res.json({ url: '/uploads/' + name });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Upload failed: ' + e.message });
    }
  });
});

app.get('/api/games/:pin/results.csv', requireHost, wrap(async (req, res) => {
  const g = await games.loadGame(String(req.params.pin).replace(/\D/g, ''));
  if (!g) return res.status(404).send('Game not found');
  const cell = (v) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = [['Rank', 'Name', 'Score', 'Correct answers'].map(cell).join(',')];
  games.ranking(g).forEach((p, i) => rows.push([i + 1, p.name, p.score, p.correctCount].map(cell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="quiz-results-${g.pin}.csv"`);
  res.send('﻿' + rows.join('\r\n'));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Local development only: on Vercel the CDN serves public/ and express.static is ignored.
if (!ON_VERCEL) {
  app.use('/uploads', express.static(LOCAL_UPLOADS, { maxAge: '7d', index: false, dotfiles: 'deny' }));
  app.get('/host', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'host.html')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { dotfiles: 'deny' }));
}

// ---------- Socket.IO ----------
const server = http.createServer(app);
const io = new Server(server, {
  path: '/api/server', addTrailingSlash: false, transports: ['websocket'], serveClient: false,
  maxHttpBufferSize: 20000, pingInterval: 20000, pingTimeout: 25000,
});
const hostNs = io.of('/host');

/*
 * Vercel only sends the exact path /api/server to this function (sub-paths are not routed to it), so:
 *   - API calls arrive as  /api/server?__path=host/login   -> handled as /api/host/login
 *   - live connections as  /api/server?EIO=4&transport=websocket (Socket.IO, path '/api/server')
 */
function normalizeUrl(req) {
  const raw = req.url || '/';
  const q = raw.indexOf('?');
  const pathname = q < 0 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  if (params.has('__path')) {
    const route = String(params.get('__path')).replace(/^\/+/, '');
    params.delete('__path');
    const rest = params.toString();
    req.url = '/api/' + route.split('/').map(encodeURIComponent).join('/') + (rest ? '?' + rest : '');
  } else if (params.has('EIO')) {
    req.url = '/api/server' + raw.slice(q);
  } else if (pathname.startsWith('/api/server/')) {
    req.url = '/api' + raw.slice('/api/server'.length);
  }
}
server.prependListener('request', normalizeUrl);
server.prependListener('upgrade', normalizeUrl);

const timers = new Map();     // pin -> { index, timer }  (auto-reveal when time runs out)
const hostSoon = new Map();   // pin -> timer            (batched host refreshes)
const playerRoom = (pin) => 'g:' + pin;
const hostRoom = (pin) => 'h:' + pin;

function armTimer(g) {
  const cur = timers.get(g.pin);
  if (g.state !== 'question') {
    if (cur) { clearTimeout(cur.timer); timers.delete(g.pin); }
    return;
  }
  if (cur && cur.index === g.qIndex) return;
  if (cur) clearTimeout(cur.timer);
  const index = g.qIndex;
  const timer = setTimeout(() => {
    timers.delete(g.pin);
    games.timeUp(g.pin, index).catch((e) => console.error('timeUp failed:', e.message));
  }, Math.max(0, g.qEnd - Date.now()) + 300);
  timers.set(g.pin, { index, timer });
}

// push the current state to the sockets connected to THIS instance
async function refresh(pin, includePlayers) {
  const hostIds = hostNs.adapter.rooms.get(hostRoom(pin));
  const playerIds = includePlayers ? io.of('/').adapter.rooms.get(playerRoom(pin)) : null;
  if (!(hostIds && hostIds.size) && !(playerIds && playerIds.size)) return;
  const g = await games.loadGame(pin);
  if (!g) return;
  armTimer(g);
  if (hostIds && hostIds.size) hostNs.to(hostRoom(pin)).emit('state', games.hostState(g));
  if (playerIds && playerIds.size) {
    const rankMap = new Map(games.ranking(g).map((p, i) => [p.id, i + 1]));
    for (const id of [...playerIds]) {
      const s = io.of('/').sockets.get(id);
      if (!s) continue;
      const p = g.players.get(s.data.playerId);
      if (p) s.emit('state', games.playerState(g, p, rankMap));
      else { s.emit('kicked'); s.leave(playerRoom(pin)); s.data.playerId = null; s.data.pin = null; }
    }
  }
}

function onEvent(ev) {
  if (!ev || !ev.pin) return;
  const pin = String(ev.pin);
  if (ev.t === 'state') {
    refresh(pin, true).catch((e) => console.error('refresh failed:', e.message));
  } else if (!hostSoon.has(pin)) {
    // many players joining / answering at once -> one host update per 200 ms
    hostSoon.set(pin, setTimeout(() => {
      hostSoon.delete(pin);
      refresh(pin, false).catch((e) => console.error('refresh failed:', e.message));
    }, 200));
  }
}

const reply = (cb, data) => { if (typeof cb === 'function') cb(data); };
const guard = (fn) => (data, cb) => {
  Promise.resolve().then(() => fn(data || {}, cb)).catch((e) => {
    console.error(e);
    reply(cb, { error: /REDIS_URL/.test(e.message) ? e.message : 'Server error, please try again' });
  });
};
const cleanPin = (v) => String(v || '').replace(/\D/g, '').slice(0, 6);

// ----- quiz master -----
hostNs.use((socket, next) => (sessionValid(socket.request.headers.cookie) ? next() : next(new Error('unauthorized'))));

hostNs.on('connection', (socket) => {
  games.subscribe(onEvent);

  socket.on('host:create', guard(async (data, cb) => {
    const quiz = await games.getQuiz(data.quizId);
    if (!quiz) return reply(cb, { error: 'Quiz not found' });
    const pin = await games.createGame(quiz);
    socket.join(hostRoom(pin));
    reply(cb, { ok: true, pin });
    await refresh(pin, false);
  }));

  socket.on('host:resume', guard(async (data, cb) => {
    const pin = cleanPin(data.pin);
    const g = await games.loadGame(pin);
    if (!g) return reply(cb, { error: 'Game not found' });
    socket.join(hostRoom(pin));
    armTimer(g);
    reply(cb, { ok: true });
    socket.emit('state', games.hostState(g));
  }));

  socket.on('host:next', guard(async (data, cb) => {
    reply(cb, await games.advance(cleanPin(data.pin), { state: String(data.state), index: data.index }));
  }));

  socket.on('host:timeup', guard(async (data, cb) => {
    reply(cb, await games.timeUp(cleanPin(data.pin), Number(data.index)));
  }));

  socket.on('host:kick', guard(async (data, cb) => {
    reply(cb, await games.kick(cleanPin(data.pin), data.playerId));
  }));

  socket.on('host:close', guard(async (data, cb) => {
    const pin = cleanPin(data.pin);
    const res = await games.close(pin);
    if (data.leave) socket.leave(hostRoom(pin));
    reply(cb, res);
  }));
});

// ----- players -----
io.on('connection', (socket) => {
  games.subscribe(onEvent);
  const ip = String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address).split(',')[0].trim();
  let failures = 0;

  async function attach(pin, playerId) {
    if (socket.data.pin && socket.data.pin !== pin) socket.leave(playerRoom(socket.data.pin));
    socket.data.pin = pin; socket.data.playerId = playerId;
    socket.join(playerRoom(pin));
    const g = await games.loadGame(pin);
    const p = g && g.players.get(playerId);
    if (!p) return;
    armTimer(g);
    socket.emit('state', games.playerState(g, p));
  }

  socket.on('player:join', guard(async (data, cb) => {
    // a venue often shares one IP address, so the per-IP limit is generous and each connection has its own
    if (failures >= 10 || await games.limited('pin:' + ip, 600)) return reply(cb, { error: 'Too many attempts. Please wait a minute.' });
    const pin = cleanPin(data.pin);
    const res = data.playerId ? await games.rejoin(pin, data.playerId) : await games.join(pin, data.name);
    if (res.gone) { failures++; await games.countHit('pin:' + ip, 60); }
    reply(cb, res);
    if (res.ok) await attach(pin, res.playerId);
  }));

  // pin + playerId travel with every answer, so it still works right after a reconnect to another instance
  socket.on('player:answer', guard(async (data, cb) => {
    const pin = cleanPin(data.pin || socket.data.pin);
    const playerId = String(data.playerId || socket.data.playerId || '');
    if (!pin || !playerId) return reply(cb, { error: 'Not in a quiz' });
    reply(cb, await games.answer(pin, playerId, data.choice));
  }));

  socket.on('disconnect', () => {
    if (socket.data.pin && socket.data.playerId) games.setOffline(socket.data.pin, socket.data.playerId).catch(() => {});
  });
});

// Vercel runs the exported server; locally `npm start` listens on a port.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Live Quiz running on http://localhost:${PORT}/  (quiz master: /host)`);
  });
}

module.exports = server;
