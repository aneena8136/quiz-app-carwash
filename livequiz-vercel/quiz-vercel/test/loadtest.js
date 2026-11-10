'use strict';
/*
 * Load test: simulates a full game with many players.
 * Usage:  HOST_PASSWORD=<same as server> node test/loadtest.js [players] [baseUrl]
 */
const { io: ioClient } = require('socket.io-client');
const SOCK = { path: '/api/server/socket.io', transports: ['websocket'] };
const io = (url, opts) => ioClient(url, { ...SOCK, ...(opts || {}) });
const fs = require('fs');
const os = require('os');
const path = require('path');

const N = parseInt(process.argv[2], 10) || 150;
const BASES = (process.argv[3] || 'http://localhost:3000').split(',');
const BASE = BASES[0];
const B2 = BASES[BASES.length - 1]; // second instance (if given) to prove instances share state
const PASSWORD = process.env.HOST_PASSWORD;
if (!PASSWORD) { console.error('Set HOST_PASSWORD to the quiz master password'); process.exit(1); }

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const waitFor = (fn, ms = 15000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function poll() {
    if (fn()) return res();
    if (Date.now() - t0 > ms) return rej(new Error('timeout'));
    setTimeout(poll, 20);
  })();
});

(async () => {
  // 1. login
  let r = await fetch(BASE + '/api/server/host/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) });
  assert(r.status === 401, 'wrong password must be rejected');
  r = await fetch(BASE + '/api/server/host/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert(r.ok, 'login failed');
  const cookie = r.headers.get('set-cookie').split(';')[0];

  // 2. security checks
  r = await fetch(BASE + '/api/server/quizzes');
  assert(r.status === 401, 'quizzes must need login');
  let fd = new FormData();
  fd.append('image', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.png');
  r = await fetch(BASE + '/api/server/upload', { method: 'POST', body: fd, headers: { cookie } });
  assert(r.status === 400, 'fake image must be rejected');
  fd = new FormData();
  fd.append('image', new Blob(['x'], { type: 'image/png' }), 'x.png');
  r = await fetch(BASE + '/api/server/upload', { method: 'POST', body: fd });
  assert(r.status === 401, 'upload must need login');

  // 3. upload a real (1x1 png) image and create a quiz
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), '../../evil.png');
  r = await fetch(BASE + '/api/server/upload', { method: 'POST', body: fd, headers: { cookie } });
  assert(r.ok, 'image upload failed');
  const { url } = await r.json();
  assert(/\/[a-f0-9]{32}\.png$/.test(url) && !url.includes('evil'), 'upload name must be random');
  const imgUrl = url.startsWith('http') ? url : BASE + url;
  r = await fetch(imgUrl);
  assert(r.ok && r.headers.get('content-type') === 'image/png', 'image must be served');

  const questions = [0, 1, 2].map((i) => ({ text: 'Question ' + (i + 1), image: url, options: ['A', 'B', 'C', 'D'], correct: i, time: 10 }));
  r = await fetch(B2 + '/api/server/quizzes', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ title: 'Load test quiz', questions }) });
  assert(r.ok, 'quiz save failed');
  const quiz = await r.json();

  // 4. host socket
  const unauth = io(BASE + '/host', { reconnection: false });
  await new Promise((res) => unauth.on('connect_error', res));
  const host = io(BASE + '/host', { extraHeaders: { cookie } });
  let hs = null;
  host.on('state', (s) => { hs = s; });
  await new Promise((res) => host.on('connect', res));
  const created = await emit(host, 'host:create', { quizId: quiz.id });
  assert(created.ok && /^\d{6}$/.test(created.pin), 'game create failed');
  const pin = created.pin;

  // 5. players join
  const players = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: N }, async (_, i) => {
    const s = io(BASES[i % BASES.length]); // players are spread over all instances
    const p = { s, state: null, i };
    s.on('state', (st) => { p.state = st; });
    await new Promise((res) => s.on('connect', res));
    const res = await emit(s, 'player:join', { pin, name: 'Player ' + (i + 1) });
    p.pin = pin;
    assert(res.ok, 'join failed: ' + res.error);
    p.id = res.playerId;
    players.push(p);
  }));
  console.log(`${N} players joined in ${Date.now() - t0} ms`);

  const dup = io(B2);
  await new Promise((res) => dup.on('connect', res));
  assert((await emit(dup, 'player:join', { pin, name: 'player 1' })).error, 'duplicate name must be rejected');
  assert((await emit(dup, 'player:join', { pin: '000000', name: 'Nobody' })).error, 'wrong pin must be rejected');
  dup.close();

  await waitFor(() => hs && hs.players.length === N);

  // 6. play all questions. Player i answers correctly on question q if (i % 4) <= ... varied
  for (let q = 0; q < questions.length; q++) {
    await emit(host, 'host:next', { pin, state: hs.state, index: hs.index });
    await waitFor(() => players.every((p) => p.state.state === 'question' && p.state.index === q));
    assert(players.every((p) => p.state.correct === undefined), 'correct answer must not be sent to players before reveal');
    const ta = Date.now();
    const results = await Promise.all(players.map((p) => emit(p.s, 'player:answer', { pin, playerId: p.id, choice: p.i % 4 })));
    assert(results.every((x) => x.ok), 'an answer was rejected'); const tAck = Date.now() - ta;
    await waitFor(() => players.every((p) => p.state.state === 'reveal' && p.state.index === q));
    console.log(`Question ${q + 1}: ${N} answers processed and revealed in ${Date.now() - ta} ms (acks after ${tAck} ms)`);
    for (const p of players) {
      const should = p.i % 4 === q;
      assert(p.state.isCorrect === should, 'wrong marking');
      assert(should ? p.state.points >= 500 && p.state.points <= 1000 : p.state.points === 0, 'wrong points');
    }
    assert(hs.state === 'reveal' && hs.counts.reduce((a, b) => a + b, 0) === N, 'host counts wrong');
  }

  // a stale "next" (double click) must not skip anything
  const stale = await emit(host, 'host:next', { pin, state: 'question', index: questions.length - 1 });
  assert(stale.ok && hs.state === 'reveal', 'stale click must be ignored');

  // 7. reconnect keeps the score
  const one = players[0];
  const before = one.state.score;
  one.s.close();
  const s2 = io(B2); // reconnect lands on another instance
  let st2 = null;
  s2.on('state', (st) => { st2 = st; });
  await new Promise((res) => s2.on('connect', res));
  const rj = await emit(s2, 'player:join', { pin, playerId: one.id });
  assert(rj.ok, 'rejoin failed');
  await waitFor(() => st2);
  assert(st2.score === before, 'score lost on reconnect');

  // 8. finish
  await emit(host, 'host:next', { pin, state: hs.state, index: hs.index });
  await waitFor(() => hs.state === 'ended');
  await waitFor(() => players.slice(1).every((p) => p.state.state === 'ended'));
  assert(hs.leaderboard.length === Math.min(10, N), 'leaderboard missing');
  const ranks = new Set(players.slice(1).map((p) => p.state.rank));
  assert(ranks.size === N - 1, 'ranks must be unique');
  r = await fetch(`${BASE}/api/server/games/${pin}/results.csv`, { headers: { cookie } });
  const csv = await r.text();
  assert(r.ok && csv.trim().split('\n').length === N + 1, 'csv export wrong');
  r = await fetch(`${BASE}/api/server/games/${pin}/results.csv`);
  assert(r.status === 401, 'csv must need login');

  await fetch(BASE + '/api/server/quizzes/' + quiz.id, { method: 'DELETE', headers: { cookie } });
  if (!url.startsWith('http')) { // blob deletions take up to a minute to leave the CDN cache
    r = await fetch(imgUrl);
    assert(r.status === 404, 'image should be removed with quiz');
  }

  console.log('ALL CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
