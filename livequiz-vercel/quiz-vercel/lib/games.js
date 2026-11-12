'use strict';
/*
 * Game engine + storage. Everything lives in Redis so that any Vercel Function
 * instance can serve any player (instances do not share memory).
 */
const Redis = require('ioredis');
const crypto = require('crypto');

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL; // set by the Redis integration - never hardcode
const K = 'lq:';
const CHANNEL = K + 'events';
const GAME_TTL = 4 * 60 * 60;      // seconds
const ENDED_TTL = 30 * 60;
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS, 10) || 500;

let client = null;
let subscriber = null;

function newClient() {
  if (!REDIS_URL) throw new Error('REDIS_URL is not set. Connect a Redis database to this project.');
  const c = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, connectTimeout: 10000 });
  c.on('error', (e) => console.error('Redis error:', e.message));
  return c;
}
function r() { return client || (client = newClient()); }

const gk = (pin) => K + 'g:' + pin;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const parseMap = (obj) => new Map(Object.entries(obj || {}).map(([id, j]) => [id, JSON.parse(j)]));

// ---------- pub/sub between instances ----------
function publish(pin, t) { return r().publish(CHANNEL, JSON.stringify({ pin, t })); }

function subscribe(handler) {
  if (subscriber) return;
  subscriber = newClient();
  subscriber.subscribe(CHANNEL).catch((e) => console.error('Redis subscribe failed:', e.message));
  subscriber.on('message', (ch, msg) => {
    try { handler(JSON.parse(msg)); } catch (e) { console.error('Bad event', e.message); }
  });
}

// ---------- rate limiting ----------
async function limited(key, max) {
  return Number(await r().get(K + 'rl:' + key)) >= max;
}
async function countHit(key, windowSec) {
  const k = K + 'rl:' + key;
  const n = await r().incr(k);
  if (n === 1) await r().expire(k, windowSec);
}

// ---------- quizzes ----------
async function listQuizzes() {
  const all = (await r().hvals(K + 'quizzes')).map((j) => JSON.parse(j));
  return all.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
async function getQuiz(id) {
  const j = await r().hget(K + 'quizzes', String(id));
  return j ? JSON.parse(j) : null;
}
async function saveQuiz(quiz) { await r().hset(K + 'quizzes', quiz.id, JSON.stringify(quiz)); }
async function deleteQuiz(id) { await r().hdel(K + 'quizzes', String(id)); }

// ---------- games ----------
async function getMeta(pin) {
  const j = await r().get(gk(pin));
  return j ? JSON.parse(j) : null;
}
function metaTtl(meta) {
  if (meta.state === 'ended') return ENDED_TTL;
  return Math.max(60, GAME_TTL - Math.floor((Date.now() - meta.createdAt) / 1000));
}
function putMeta(pipe, meta) { return pipe.set(gk(meta.pin), JSON.stringify(meta), 'EX', metaTtl(meta)); }

const QUESTION_TIME = 20; // every question gets 20 seconds, whatever the saved quiz says

async function createGame(quiz) {
  quiz = { ...quiz, questions: quiz.questions.map((q) => ({ ...q, time: QUESTION_TIME })) };
  for (let i = 0; i < 20; i++) {
    const pin = String(crypto.randomInt(1000, 10000)); // 4-digit game PIN
    const meta = { pin, quiz, state: 'lobby', qIndex: -1, qStart: 0, qEnd: 0, createdAt: Date.now(), endedAt: 0 };
    if (await r().set(gk(pin), JSON.stringify(meta), 'EX', GAME_TTL, 'NX')) return pin;
  }
  throw new Error('Could not create a game, please try again');
}

async function loadGame(pin) {
  const k = gk(pin);
  const res = await r().pipeline().get(k).hgetall(k + ':players').smembers(k + ':online').exec();
  if (!res[0][1]) return null;
  const meta = JSON.parse(res[0][1]);
  let answers = new Map();
  if (meta.state === 'question' || meta.state === 'reveal') answers = parseMap(await r().hgetall(k + ':a:' + meta.qIndex));
  return { ...meta, players: parseMap(res[1][1]), answers, online: new Set(res[2][1] || []) };
}

// one instance at a time may change a game's phase
// `stale` (optional) is re-checked while waiting, so callers whose work was already done by someone else leave at once
async function withLock(pin, fn, stale) {
  const key = gk(pin) + ':lock';
  const token = crypto.randomBytes(8).toString('hex');
  for (let i = 0; i < 40; i++) {
    if (await r().set(key, token, 'PX', 5000, 'NX')) {
      try { return await fn(); }
      finally {
        await r().eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0", 1, key, token).catch(() => {});
      }
    }
    await sleep(40 + Math.floor(Math.random() * 30));
    if (stale && (await stale())) return { ok: true, stale: true };
  }
  return { error: 'Busy, please try again' };
}

function cleanName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// A player counts as online while their *latest* connection is open. Vercel recycles connections,
// so an old connection's late 'disconnect' must not mark a player offline after they reconnected.
async function join(pin, rawName, sid) {
  const meta = await getMeta(pin);
  if (!meta) return { error: 'No quiz found with that PIN', gone: true };
  if (meta.state === 'ended') return { error: 'This quiz has already finished' };
  const name = cleanName(rawName);
  if (name.length < 2) return { error: 'Please enter a name (at least 2 characters)' };
  const k = gk(pin);
  if ((await r().hlen(k + ':players')) >= MAX_PLAYERS) return { error: 'This quiz is full' };
  const id = crypto.randomBytes(16).toString('hex');
  if (!(await r().hsetnx(k + ':names', name.toLowerCase(), id))) return { error: 'That name is taken - try another' };
  const player = { id, name, score: 0, correctCount: 0, joinedAt: Date.now(), last: null };
  await r().pipeline()
    .hset(k + ':players', id, JSON.stringify(player))
    .sadd(k + ':online', id)
    .hset(k + ':sock', id, String(sid || ''))
    .expire(k + ':players', GAME_TTL).expire(k + ':names', GAME_TTL).expire(k + ':online', GAME_TTL).expire(k + ':sock', GAME_TTL)
    .exec();
  await publish(pin, 'host');
  return { ok: true, playerId: id, name };
}

async function rejoin(pin, playerId, sid) {
  const k = gk(pin);
  const j = await r().hget(k + ':players', String(playerId));
  if (!j) return { error: 'Session expired', gone: true };
  await r().pipeline().sadd(k + ':online', String(playerId)).hset(k + ':sock', String(playerId), String(sid || '')).expire(k + ':sock', GAME_TTL).exec();
  await publish(pin, 'host');
  const p = JSON.parse(j);
  return { ok: true, playerId: p.id, name: p.name };
}

async function setOffline(pin, playerId, sid) {
  const k = gk(pin);
  // only if this connection is still the player's latest one
  const changed = await r().eval(
    "if redis.call('hget', KEYS[2], ARGV[1]) == ARGV[2] then redis.call('srem', KEYS[1], ARGV[1]); redis.call('hdel', KEYS[2], ARGV[1]); return 1 end return 0",
    2, k + ':online', k + ':sock', String(playerId), String(sid || ''));
  if (changed) await publish(pin, 'host');
}

async function startQuestion(meta, index) {
  const q = meta.quiz.questions[index];
  meta.state = 'question'; meta.qIndex = index;
  meta.qStart = Date.now(); meta.qEnd = meta.qStart + q.time * 1000;
  await putMeta(r().pipeline(), meta).exec();
}

async function doReveal(meta) {
  const k = gk(meta.pin);
  const q = meta.quiz.questions[meta.qIndex];
  const players = parseMap(await r().hgetall(k + ':players'));
  const answers = parseMap(await r().hgetall(k + ':a:' + meta.qIndex));
  const pipe = r().multi();
  for (const p of players.values()) {
    const a = answers.get(p.id);
    const isCorrect = !!a && a.choice === q.correct;
    // 10 points for a correct answer + up to 10 more for answering fast (10-20 per question)
    const points = isCorrect ? Math.round(10 + 10 * Math.max(0, 1 - a.ms / (q.time * 1000))) : 0;
    p.score += points;
    if (isCorrect) { p.correctCount++; p.correctMs = (p.correctMs || 0) + a.ms; }
    p.last = { qIndex: meta.qIndex, choice: a ? a.choice : null, isCorrect, points };
    pipe.hset(k + ':players', p.id, JSON.stringify(p));
  }
  meta.state = 'reveal';
  await putMeta(pipe, meta).exec(); // scores and phase change together
}

async function endGame(meta) {
  const k = gk(meta.pin);
  meta.state = 'ended'; meta.endedAt = Date.now();
  await putMeta(r().multi(), meta)
    .expire(k + ':players', ENDED_TTL).expire(k + ':names', ENDED_TTL).expire(k + ':online', ENDED_TTL).expire(k + ':sock', ENDED_TTL)
    .exec();
}

/*
 * Move the game forward. `expect` = { state, index } the caller is looking at;
 * if the game has already moved on (double click, timer raced a click) nothing happens.
 */
async function advance(pin, expect) {
  const moved = (meta) => !!expect && (expect.state !== meta.state || (expect.state !== 'lobby' && Number(expect.index) !== meta.qIndex));
  const res = await withLock(pin, async () => {
    const meta = await getMeta(pin);
    if (!meta) return { error: 'Game not found' };
    if (moved(meta)) return { ok: true, stale: true };
    if (expect && expect.onlyAfterDeadline && Date.now() < meta.qEnd - 250) return { ok: true, stale: true };
    if (meta.state === 'lobby') {
      if ((await r().hlen(gk(pin) + ':players')) === 0) return { error: 'Wait for at least one player to join' };
      await startQuestion(meta, 0);
    } else if (meta.state === 'question') {
      await doReveal(meta);
    } else if (meta.state === 'reveal') {
      if (meta.qIndex + 1 < meta.quiz.questions.length) await startQuestion(meta, meta.qIndex + 1);
      else await endGame(meta);
    } else return { ok: true, stale: true };
    return { ok: true };
  }, async () => { const m = await getMeta(pin); return !m || moved(m); });
  if (res.ok && !res.stale) await publish(pin, 'state');
  return res;
}

const timeUp = (pin, index) => advance(pin, { state: 'question', index, onlyAfterDeadline: true });

async function close(pin) {
  const res = await withLock(pin, async () => {
    const meta = await getMeta(pin);
    if (!meta) return { error: 'Game not found' };
    if (meta.state === 'ended') return { ok: true, stale: true };
    await endGame(meta);
    return { ok: true };
  });
  if (res.ok && !res.stale) await publish(pin, 'state');
  return res;
}

async function answer(pin, playerId, rawChoice, sid) {
  const meta = await getMeta(pin);
  if (!meta) return { error: 'Not in a quiz' };
  const now = Date.now(); // timing is measured on the server
  if (meta.state !== 'question' || now > meta.qEnd + 400) {
    if (meta.state === 'question') timeUp(pin, meta.qIndex).catch(() => {});
    return { error: 'Time is up' };
  }
  const q = meta.quiz.questions[meta.qIndex];
  const choice = Number(rawChoice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return { error: 'Invalid answer' };
  const k = gk(pin);
  const id = String(playerId);
  if (!(await r().hexists(k + ':players', id))) return { error: 'Not in a quiz' };
  const aKey = k + ':a:' + meta.qIndex;
  const fresh = await r().hsetnx(aKey, id, JSON.stringify({ choice, ms: Math.max(0, now - meta.qStart) }));
  if (!fresh) return { error: 'Already answered' };
  // a player who answers is clearly connected: make sure they count as online on this connection
  const pipe = r().pipeline().sadd(k + ':online', id);
  if (sid) pipe.hset(k + ':sock', id, String(sid));
  const res = await pipe.expire(aKey, GAME_TTL).hlen(aKey).scard(k + ':online').exec();
  const answered = res[res.length - 2][1], online = res[res.length - 1][1];
  if (online > 0 && answered >= online) await advance(pin, { state: 'question', index: meta.qIndex });
  else await publish(pin, 'host');
  return { ok: true };
}

async function kick(pin, playerId) {
  const k = gk(pin);
  const id = String(playerId);
  const j = await r().hget(k + ':players', id);
  if (!j) return { error: 'Player not found' };
  const p = JSON.parse(j);
  const meta = await getMeta(pin);
  const pipe = r().pipeline().hdel(k + ':players', id).hdel(k + ':names', p.name.toLowerCase()).srem(k + ':online', id).hdel(k + ':sock', id);
  if (meta && meta.qIndex >= 0) pipe.hdel(k + ':a:' + meta.qIndex, id);
  await pipe.exec();
  await publish(pin, 'state');
  return { ok: true };
}

// ---------- views ----------
function ranking(g) {
  // equal scores: whoever answered their correct questions faster in total ranks higher
  return [...g.players.values()].sort((a, b) => b.score - a.score || (a.correctMs || 0) - (b.correctMs || 0) || a.joinedAt - b.joinedAt);
}
const topN = (g, n) => ranking(g).slice(0, n).map((p) => ({ name: p.name, score: p.score }));

function publicQuestion(g) {
  const q = g.quiz.questions[g.qIndex];
  return { index: g.qIndex, total: g.quiz.questions.length, text: q.text, image: q.image, options: q.options, time: q.time };
}

function hostState(g) {
  const s = {
    pin: g.pin, title: g.quiz.title, state: g.state, total: g.quiz.questions.length,
    players: [...g.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, connected: g.online.has(p.id) })),
  };
  if (g.state === 'question' || g.state === 'reveal') Object.assign(s, publicQuestion(g));
  if (g.state === 'question') {
    s.remainingMs = Math.max(0, g.qEnd - Date.now());
    s.answered = g.answers.size;
  }
  if (g.state === 'reveal') {
    const q = g.quiz.questions[g.qIndex];
    s.correct = q.correct;
    s.counts = q.options.map((_, i) => [...g.answers.values()].filter((a) => a.choice === i).length);
    s.answered = g.answers.size;
    s.leaderboard = topN(g, 10);
  }
  if (g.state === 'ended') s.leaderboard = topN(g, 10);
  return s;
}

function playerState(g, p, rankMap) {
  const s = { pin: g.pin, state: g.state, title: g.quiz.title, name: p.name, score: p.score, playerCount: g.players.size };
  if (g.state === 'question') {
    Object.assign(s, publicQuestion(g));
    s.remainingMs = Math.max(0, g.qEnd - Date.now());
    const a = g.answers.get(p.id);
    s.choice = a ? a.choice : null;
  }
  if (g.state === 'reveal' || g.state === 'ended') {
    s.rank = rankMap ? rankMap.get(p.id) : ranking(g).findIndex((x) => x.id === p.id) + 1;
  }
  if (g.state === 'reveal') {
    const q = g.quiz.questions[g.qIndex];
    const last = p.last && p.last.qIndex === g.qIndex ? p.last : { choice: null, isCorrect: false, points: 0 };
    Object.assign(s, {
      index: g.qIndex, total: g.quiz.questions.length, correct: q.correct, correctText: q.options[q.correct],
      choice: last.choice, isCorrect: last.isCorrect, points: last.points,
    });
  }
  if (g.state === 'ended') s.top = topN(g, 3);
  return s;
}

module.exports = {
  publish, subscribe, limited, countHit,
  listQuizzes, getQuiz, saveQuiz, deleteQuiz,
  createGame, loadGame, getMeta, join, rejoin, setOffline, advance, timeUp, close, answer, kick,
  ranking, hostState, playerState,
};
