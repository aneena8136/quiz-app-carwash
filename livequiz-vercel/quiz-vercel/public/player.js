(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var SHAPES = ['▲', '◆', '●', '■'];
  var KEY = 'livequiz.player';
  var views = ['join', 'lobby', 'question', 'reveal', 'ended'];
  // Vercel needs the WebSocket transport and the function's path
  var socket = io({ path: '/api/server', addTrailingSlash: false, transports: ['websocket'], reconnectionDelay: 300, reconnectionDelayMax: 3000 });
  var tick = null;
  var current = null;

  function show(name) {
    views.forEach(function (v) { $('v-' + v).classList.toggle('hidden', v !== name); });
  }
  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
  function save(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch (e) {} }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function startTimer(ms) {
    clearInterval(tick);
    var end = Date.now() + ms;
    function draw() {
      var left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      $('q-timer').textContent = left;
      $('q-timer').classList.toggle('low', left <= 5);
      if (left <= 0) clearInterval(tick);
    }
    draw();
    tick = setInterval(draw, 250);
  }

  function renderQuestion(s) {
    var fresh = !current || current.state !== 'question' || current.index !== s.index;
    $('q-count').textContent = 'Question ' + (s.index + 1) + ' of ' + s.total;
    $('q-text').textContent = s.text;
    var img = $('q-image');
    if (s.image) { if (img.getAttribute('src') !== s.image) img.src = s.image; img.classList.remove('hidden'); }
    else { img.classList.add('hidden'); img.removeAttribute('src'); }
    var box = $('q-options');
    box.textContent = '';
    s.options.forEach(function (text, i) {
      var b = document.createElement('button');
      b.className = 'opt o' + i;
      var sh = document.createElement('span'); sh.className = 'shape'; sh.textContent = SHAPES[i];
      var tx = document.createElement('span'); tx.textContent = text;
      b.appendChild(sh); b.appendChild(tx);
      if (s.choice !== null && s.choice !== undefined) {
        b.disabled = true;
        b.classList.add(i === s.choice ? 'picked' : 'dim');
      }
      b.addEventListener('click', function () { answer(i); });
      box.appendChild(b);
    });
    $('q-wait').classList.toggle('hidden', s.choice === null || s.choice === undefined);
    if (fresh || !tick) startTimer(s.remainingMs);
    show('question');
  }

  function answer(i) {
    if (!current || current.state !== 'question' || current.choice != null) return;
    current.choice = i;
    renderQuestion(current);
    var me = load() || {};
    socket.emit('player:answer', { pin: me.pin, playerId: me.playerId, choice: i }, function (res) {
      if (res && res.error && res.error !== 'Already answered' && current && current.state === 'question') {
        $('q-wait').textContent = res.error;
      }
    });
  }

  function render(s) {
    if (s.state === 'question') { renderQuestion(s); current = s; return; }
    clearInterval(tick); tick = null;
    current = s;
    if (s.state === 'lobby') {
      $('lobby-name').textContent = s.name;
      $('lobby-title').textContent = s.title;
      show('lobby');
    } else if (s.state === 'reveal') {
      var none = s.choice === null || s.choice === undefined;
      $('r-emoji').textContent = s.isCorrect ? '✅' : (none ? '⏰' : '❌');
      $('r-title').textContent = s.isCorrect ? 'Correct!' : (none ? 'No answer' : 'Not quite');
      $('r-title').className = s.isCorrect ? 'result-good' : 'result-bad';
      $('r-answer').textContent = 'Correct answer: ' + s.correctText;
      $('r-points').textContent = '+' + s.points;
      $('r-score').textContent = s.score;
      $('r-rank').textContent = ordinal(s.rank) + ' of ' + s.playerCount;
      show('reveal');
    } else if (s.state === 'ended') {
      $('f-rank').textContent = ordinal(s.rank) + ' of ' + s.playerCount;
      $('f-score').textContent = s.score;
      var top = $('f-top');
      top.textContent = '';
      (s.top || []).forEach(function (p, i) {
        var row = document.createElement('p');
        row.textContent = ['🥇', '🥈', '🥉'][i] + ' ' + p.name + ' - ' + p.score;
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
    var saved = load();
    if (!saved) return;
    // rejoin automatically after a refresh or a dropped connection
    socket.emit('player:join', { pin: saved.pin, playerId: saved.playerId }, function (res) {
      if (res && res.gone) reset('');
    });
  });

  var q = new URLSearchParams(location.search).get('pin');
  if (q) $('pin').value = q.replace(/\D/g, '').slice(0, 6);
})();
