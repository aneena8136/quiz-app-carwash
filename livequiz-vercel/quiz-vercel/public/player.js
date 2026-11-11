(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var LETTERS = ['A', 'B', 'C', 'D'];
  var KEY = 'livequiz.player';
  var me = null; // this tab's player { pin, playerId, name }
  var views = ['join', 'lobby', 'question', 'reveal', 'ended'];
  // Vercel needs the WebSocket transport and the function's path
  var socket = io({ path: '/api/server', addTrailingSlash: false, transports: ['websocket'], reconnectionDelay: 300, reconnectionDelayMax: 3000 });
  var tick = null;
  var current = null;

  function show(name) {
    views.forEach(function (v) { $('v-' + v).classList.toggle('hidden', v !== name); });
    $('hdr-score').classList.toggle('hidden', name === 'join');
  }
  // Each browser tab keeps its own player (sessionStorage), so two players in one browser don't mix.
  // The last player is also kept in localStorage so a phone can resume after its tab was closed,
  // but only if no other open tab is still using that player (checked with a heartbeat).
  function hbKey(id) { return KEY + '.hb.' + id; }
  function load() {
    try {
      var s = JSON.parse(sessionStorage.getItem(KEY));
      if (s && s.playerId) return s;
      var l = JSON.parse(localStorage.getItem(KEY));
      if (l && l.playerId && Date.now() - (Number(localStorage.getItem(hbKey(l.playerId))) || 0) > 6000) return l;
    } catch (e) {}
    return null;
  }
  function save(v) {
    var old = me;
    me = v;
    try {
      if (v) {
        sessionStorage.setItem(KEY, JSON.stringify(v));
        localStorage.setItem(KEY, JSON.stringify(v));
        localStorage.setItem(hbKey(v.playerId), String(Date.now()));
      } else {
        sessionStorage.removeItem(KEY);
        if (old) {
          localStorage.removeItem(hbKey(old.playerId));
          var l = JSON.parse(localStorage.getItem(KEY) || 'null');
          if (l && l.playerId === old.playerId) localStorage.removeItem(KEY);
        }
      }
    } catch (e) {}
  }
  setInterval(function () { if (me) { try { localStorage.setItem(hbKey(me.playerId), String(Date.now())); } catch (e) {} } }, 2000);
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function setScore(score) { $('hdr-score').textContent = (score || 0).toLocaleString() + ' pts'; }

  // shrinking time bar + seconds counter
  function startTimer(ms, totalMs) {
    clearInterval(tick);
    var end = Date.now() + ms;
    var bar = $('q-bar');
    bar.style.transition = 'none';
    bar.style.width = Math.min(100, (ms / totalMs) * 100) + '%';
    void bar.offsetWidth;
    bar.style.transition = 'width ' + ms + 'ms linear';
    bar.style.width = '0%';
    function draw() {
      var left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      $('q-timer').textContent = left + 's';
      $('v-question').classList.toggle('low', left <= 5);
      if (left <= 0) clearInterval(tick);
    }
    draw();
    tick = setInterval(draw, 250);
  }

  function renderQuestion(s) {
    var fresh = !current || current.state !== 'question' || current.index !== s.index;
    $('q-count').textContent = 'Question ' + (s.index + 1) + ' / ' + s.total;
    $('q-text').textContent = s.text;
    $('q-text').classList.toggle('hidden', !s.text);
    var img = $('q-image');
    if (s.image) { if (img.getAttribute('src') !== s.image) img.src = s.image; $('q-media').classList.remove('hidden'); }
    else { $('q-media').classList.add('hidden'); img.removeAttribute('src'); }
    var answered = s.choice !== null && s.choice !== undefined;
    var box = $('q-options');
    box.textContent = '';
    s.options.forEach(function (text, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt o' + i;
      var badge = document.createElement('span'); badge.className = 'letter'; badge.textContent = LETTERS[i];
      var tx = document.createElement('span'); tx.className = 'label'; tx.textContent = text;
      b.appendChild(badge); b.appendChild(tx);
      if (answered) {
        b.disabled = true;
        b.classList.add(i === s.choice ? 'picked' : 'dim');
      }
      b.addEventListener('click', function () { answer(i); });
      box.appendChild(b);
    });
    $('q-wait').classList.toggle('hidden', !answered);
    setScore(s.score);
    show('question'); // must be visible before the time bar starts animating
    if (fresh || !tick) startTimer(s.remainingMs, s.time * 1000);
  }

  function answer(i) {
    if (!current || current.state !== 'question' || current.choice != null) return;
    current.choice = i;
    renderQuestion(current);
    if (!me) return;
    socket.emit('player:answer', { pin: me.pin, playerId: me.playerId, choice: i }, function (res) {
      if (res && res.error && res.error !== 'Already answered' && current && current.state === 'question') {
        $('q-wait-text').textContent = res.error;
      }
    });
  }

  function render(s) {
    if (s.state === 'question') { renderQuestion(s); current = s; return; }
    clearInterval(tick); tick = null;
    current = s;
    setScore(s.score);
    if (s.state === 'lobby') {
      $('lobby-name').textContent = s.name;
      $('lobby-title').textContent = s.title;
      $('lobby-count').textContent = s.playerCount + (s.playerCount === 1 ? ' player' : ' players') + ' in the room';
      show('lobby');
    } else if (s.state === 'reveal') {
      var none = s.choice === null || s.choice === undefined;
      var kind = s.isCorrect ? 'good' : (none ? 'none' : 'bad');
      $('r-icon').className = 'result-icon ' + kind;
      $('r-icon').textContent = s.isCorrect ? '✓' : (none ? '–' : '✕');
      $('v-reveal').className = 'card center result ' + kind;
      $('r-title').textContent = s.isCorrect ? 'Correct!' : (none ? 'Time’s up' : 'Not quite');
      $('r-answer').textContent = s.correctText;
      $('r-points').textContent = '+' + s.points.toLocaleString();
      $('r-score').textContent = s.score.toLocaleString();
      $('r-rank').textContent = ordinal(s.rank);
      $('r-of').textContent = 'of ' + s.playerCount;
      show('reveal');
    } else if (s.state === 'ended') {
      $('f-rank').textContent = ordinal(s.rank);
      $('f-of').textContent = 'of ' + s.playerCount + ' players';
      $('f-score').textContent = s.score.toLocaleString();
      var top = $('f-top');
      top.textContent = '';
      (s.top || []).forEach(function (p, i) {
        var row = document.createElement('div');
        row.className = 'board-row' + (i === 0 ? ' first' : '');
        var pos = document.createElement('span'); pos.className = 'pos'; pos.textContent = i + 1;
        var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
        var sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = p.score.toLocaleString();
        row.appendChild(pos); row.appendChild(nm); row.appendChild(sc);
        top.appendChild(row);
      });
      show('ended');
    }
  }

  function reset(message) {
    save(null); current = null;
    clearInterval(tick); tick = null;
    $('join-error').textContent = message || '';
    $('join-btn').disabled = false;
    show('join');
  }

  $('join-form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('join-error').textContent = '';
    $('join-btn').disabled = true;
    var pin = $('pin').value.trim(), name = $('name').value.trim();
    socket.timeout(8000).emit('player:join', { pin: pin, name: name }, function (err, res) {
      $('join-btn').disabled = false;
      if (err) { $('join-error').textContent = 'Could not reach the quiz. Check your connection and try again.'; return; }
      if (res.error) { $('join-error').textContent = res.error; return; }
      save({ pin: pin, playerId: res.playerId, name: res.name });
    });
  });

  $('again-btn').addEventListener('click', function () { reset(''); });

  socket.on('state', render);
  socket.on('kicked', function () { reset('You were removed from the quiz by the quiz master.'); });
  socket.on('disconnect', function () { $('conn').classList.remove('hidden'); });
  socket.on('connect', function () {
    $('conn').classList.add('hidden');
    var saved = me || load();
    if (!saved) return;
    // rejoin automatically after a refresh or a dropped connection
    socket.emit('player:join', { pin: saved.pin, playerId: saved.playerId }, function (res) {
      if (res && res.gone) { me = saved; reset(''); return; }
      if (res && res.ok) save(saved);
    });
  });

  // When a phone wakes up (screen on / app back in front), re-sync in case updates were missed while asleep.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !me || !socket.connected) return;
    socket.emit('player:join', { pin: me.pin, playerId: me.playerId }, function (res) {
      if (res && res.gone) reset('');
    });
  });

  var q = new URLSearchParams(location.search).get('pin');
  if (q) $('pin').value = q.replace(/\D/g, '').slice(0, 6);
})();
