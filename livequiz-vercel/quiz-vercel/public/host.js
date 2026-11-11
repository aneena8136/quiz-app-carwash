(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var LETTERS = ['A', 'B', 'C', 'D'];
  var PIN_KEY = 'livequiz.hostpin';
  // every API call goes to the single Vercel Function at /api/server, with the route in ?__path=
  function apiUrl(route) { return '/api/server?__path=' + encodeURIComponent(route.replace(/^\//, '')); }
  var SOCKET_OPTS = { path: '/api/server', addTrailingSlash: false, transports: ['websocket'], reconnectionDelay: 300, reconnectionDelayMax: 3000 };
  var views = ['login', 'list', 'edit', 'game'];
  var socket = null;
  var quizzes = [];
  var draft = null;     // quiz being edited
  var game = null;      // last game state from server
  var tick = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function show(name) {
    views.forEach(function (v) { $('v-' + v).classList.toggle('hidden', v !== name); });
    $('logout-btn').classList.toggle('hidden', name === 'login');
  }
  function api(method, url, body) {
    return fetch(apiUrl(url), {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && url !== '/host/login') { show('login'); throw new Error('Please log in'); }
        if (!r.ok) throw new Error(data.error || 'Something went wrong');
        return data;
      });
    });
  }
  function getPin() { try { return sessionStorage.getItem(PIN_KEY); } catch (e) { return null; } }
  function setPin(v) { try { v ? sessionStorage.setItem(PIN_KEY, v) : sessionStorage.removeItem(PIN_KEY); } catch (e) {} }

  // ---------- login ----------
  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('login-error').textContent = '';
    api('POST', '/host/login', { password: $('password').value })
      .then(function () { $('password').value = ''; enter(); })
      .catch(function (err) { $('login-error').textContent = err.message; });
  });
  $('logout-btn').addEventListener('click', function () {
    api('POST', '/host/logout').catch(function () {}).then(function () {
      if (socket) { socket.disconnect(); socket = null; }
      showConn(false);
      show('login');
    });
  });

  function enter() {
    connect();
    loadQuizzes().then(function () { if (!game) show('list'); });
  }

  // ---------- quiz list ----------
  function loadQuizzes() {
    return api('GET', '/quizzes').then(function (list) { quizzes = list; renderList(); }).catch(function () {});
  }
  function renderList() {
    var box = $('quiz-list');
    box.textContent = '';
    if (!quizzes.length) box.appendChild(el('p', 'muted', 'No quizzes yet. Create your first one.'));
    quizzes.forEach(function (q) {
      var row = el('div', 'quiz-item');
      var cover = q.questions.map(function (x) { return x.image; }).filter(Boolean)[0];
      var thumb = el(cover ? 'img' : 'div', 'quiz-cover' + (cover ? '' : ' empty'), cover ? undefined : q.title.trim().charAt(0).toUpperCase());
      if (cover) { thumb.src = cover; thumb.alt = ''; }
      var info = el('div', 'quiz-info');
      info.appendChild(el('div', 'name', q.title));
      info.appendChild(el('div', 'muted small', q.questions.length + ' question' + (q.questions.length === 1 ? '' : 's')));
      row.appendChild(thumb);
      var start = el('button', 'btn', 'Host live');
      start.addEventListener('click', function () { hostQuiz(q.id, start); });
      var edit = el('button', 'btn small secondary', 'Edit');
      edit.addEventListener('click', function () { openEditor(q); });
      var del = el('button', 'btn small subtle-danger', 'Delete');
      del.addEventListener('click', function () {
        if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = 'Really delete?'; return; }
        api('DELETE', '/quizzes/' + q.id).then(loadQuizzes).catch(function (err) { $('list-error').textContent = err.message; });
      });
      row.appendChild(info); row.appendChild(el('div', 'spacer'));
      row.appendChild(start); row.appendChild(edit); row.appendChild(del);
      box.appendChild(row);
    });
  }
  $('new-quiz-btn').addEventListener('click', function () { openEditor(null); });

  // ---------- editor ----------
  function blankQuestion() { return { text: '', image: '', options: ['', '', '', ''], correct: 0, time: 20 }; }
  function openEditor(q) {
    draft = q ? JSON.parse(JSON.stringify(q)) : { title: '', questions: [blankQuestion()] };
    draft.questions.forEach(function (x) { while (x.options.length < 4) x.options.push(''); });
    $('quiz-title').value = draft.title;
    $('edit-error').textContent = '';
    renderQuestions();
    show('edit');
  }
  $('back-btn').addEventListener('click', function () { show('list'); });
  $('add-q-btn').addEventListener('click', function () {
    draft.questions.push(blankQuestion());
    renderQuestions();
    $('questions').lastChild.scrollIntoView({ behavior: 'smooth' });
  });

  // shrink big photos in the browser before upload so 100+ phones load them quickly
  function shrink(file) {
    if (file.type === 'image/gif' || !window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      var max = 1600, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 600 * 1024) return file;
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (resolve) {
        c.toBlob(function (blob) { resolve(blob || file); }, 'image/jpeg', 0.85);
      });
    }).catch(function () { return file; });
  }
  function uploadImage(file) {
    return shrink(file).then(function (blob) {
      var fd = new FormData();
      fd.append('image', blob, 'image');
      return fetch(apiUrl('/upload'), { method: 'POST', body: fd, credentials: 'same-origin' });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Upload failed');
        return data.url;
      });
    });
  }

  function renderQuestions() {
    var box = $('questions');
    box.textContent = '';
    draft.questions.forEach(function (q, qi) {
      var card = el('div', 'qcard');
      var head = el('div', 'row between');
      head.appendChild(el('h3', '', 'Question ' + (qi + 1)));
      var rm = el('button', 'btn small subtle-danger', 'Remove');
      rm.disabled = draft.questions.length === 1;
      rm.addEventListener('click', function () { draft.questions.splice(qi, 1); renderQuestions(); });
      head.appendChild(rm);
      card.appendChild(head);

      card.appendChild(el('label', '', 'Image'));
      var pick = el('div', 'img-pick');
      var thumb;
      if (q.image) { thumb = el('img', 'thumb'); thumb.src = q.image; thumb.alt = 'Question image'; }
      else thumb = el('div', 'thumb empty', 'No image');
      var file = el('input'); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp,image/gif';
      file.id = 'file-' + qi; file.className = 'visually-hidden';
      var fileBtn = el('label', 'btn small secondary', q.image ? 'Replace image' : 'Upload image');
      fileBtn.htmlFor = file.id;
      var status = el('span', 'muted small', '');
      file.addEventListener('change', function () {
        if (!file.files[0]) return;
        status.textContent = 'Uploading…';
        uploadImage(file.files[0]).then(function (url) { q.image = url; renderQuestions(); })
          .catch(function (err) { status.textContent = err.message; status.className = 'error'; });
      });
      pick.appendChild(thumb); pick.appendChild(file); pick.appendChild(fileBtn);
      if (q.image) {
        var clr = el('button', 'btn small secondary', 'Remove image');
        clr.addEventListener('click', function () { q.image = ''; renderQuestions(); });
        pick.appendChild(clr);
      }
      pick.appendChild(status);
      card.appendChild(pick);

      card.appendChild(el('label', '', 'Question text'));
      var text = el('input'); text.type = 'text'; text.maxLength = 300; text.value = q.text;
      text.placeholder = 'e.g. Which city is shown in this picture?';
      text.addEventListener('input', function () { q.text = text.value; });
      card.appendChild(text);

      card.appendChild(el('label', '', 'Answer options'));
      card.appendChild(el('p', 'hint', 'Select the circle next to the correct answer. Leave C or D empty to use fewer options.'));
      q.options.forEach(function (opt, oi) {
        var row = el('div', 'opt-row');
        var radio = el('input'); radio.type = 'radio'; radio.name = 'correct-' + qi; radio.checked = q.correct === oi;
        radio.setAttribute('aria-label', 'Option ' + (oi + 1) + ' is correct');
        radio.addEventListener('change', function () { q.correct = oi; });
        var input = el('input'); input.type = 'text'; input.maxLength = 120; input.value = opt;
        input.placeholder = 'Option ' + (oi + 1);
        input.addEventListener('input', function () { q.options[oi] = input.value; });
        row.appendChild(radio); row.appendChild(el('span', 'tag o' + oi, LETTERS[oi])); row.appendChild(input);
        card.appendChild(row);
      });

      card.appendChild(el('label', '', 'Time to answer'));
      var time = el('select');
      [10, 15, 20, 30, 45, 60, 90, 120].forEach(function (t) {
        var o = el('option', '', t + ' seconds'); o.value = t; if (Number(q.time) === t) o.selected = true;
        time.appendChild(o);
      });
      time.addEventListener('change', function () { q.time = Number(time.value); });
      card.appendChild(time);
      box.appendChild(card);
    });
  }

  $('save-btn').addEventListener('click', function () {
    $('edit-error').textContent = '';
    var payload = { id: draft.id, title: $('quiz-title').value, questions: [] };
    try {
      draft.questions.forEach(function (q, i) {
        // drop trailing empty options and keep the correct answer pointing at the same option
        var kept = [];
        q.options.forEach(function (o, oi) { if (o.trim()) kept.push(oi); });
        if (kept.indexOf(q.correct) < 0) throw new Error('Question ' + (i + 1) + ': the option marked correct is empty');
        payload.questions.push({
          text: q.text, image: q.image, time: q.time,
          options: kept.map(function (oi) { return q.options[oi]; }),
          correct: kept.indexOf(q.correct),
        });
      });
    } catch (err) { $('edit-error').textContent = err.message; return; }
    api('POST', '/quizzes', payload)
      .then(function () { return loadQuizzes(); })
      .then(function () { show('list'); })
      .catch(function (err) { $('edit-error').textContent = err.message; });
  });

  // ---------- live game ----------
  // Send an event and wait for the server's reply. If no reply comes within a few seconds the
  // connection has probably gone silent, so reconnect and try once more instead of doing nothing.
  function call(event, data, cb, retried) {
    if (!socket) return cb({ error: 'Not connected. Please reload the page.' });
    socket.timeout(6000).emit(event, data, function (err, res) {
      if (!err) return cb(res || {});
      if (retried) return cb({ error: 'Can’t reach the quiz server. Check your internet connection and try again.' });
      showConn(true);
      socket.once('connect', function () { call(event, data, cb, true); });
      socket.disconnect();
      socket.connect();
    });
  }
  function showConn(on) { $('conn').classList.toggle('hidden', !on); }

  function connect() {
    if (socket) return;
    socket = io('/host', SOCKET_OPTS);
    socket.on('state', renderGame);
    socket.on('disconnect', function (reason) { if (reason !== 'io client disconnect') showConn(true); });
    socket.on('connect', function () {
      showConn(false);
      var pin = getPin();
      if (pin) socket.emit('host:resume', { pin: pin }, function (res) { if (res && res.error) { setPin(null); game = null; show('list'); } });
    });
    socket.on('connect_error', function (err) { if (err && err.message === 'unauthorized') { socket.disconnect(); socket = null; show('login'); } });
  }
  var creating = false;
  // Safety net: every 5 seconds re-read the game, in case a live update was missed.
  setInterval(function () {
    var pin = getPin();
    if (socket && socket.connected && pin && game && game.state !== 'ended') socket.emit('host:resume', { pin: pin }, function () {});
  }, 5000);

  function hostQuiz(id, btn) {
    if (creating) return;
    creating = true;
    $('list-error').textContent = '';
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    call('host:create', { quizId: id }, function (res) {
      creating = false;
      if (btn) { btn.disabled = false; btn.textContent = label; }
      if (res.error) { $('list-error').textContent = res.error; return; }
      setPin(res.pin);
    });
  }
  function act(event, data) {
    $('game-error').textContent = '';
    data = data || {};
    data.pin = getPin();
    if (game) { data.state = game.state; data.index = game.index; } // lets the server ignore double clicks
    call(event, data, function (res) { if (res && res.error) $('game-error').textContent = res.error; });
  }
  $('start-btn').addEventListener('click', function () { act('host:next'); });
  $('next-btn').addEventListener('click', function () { act('host:next'); });
  $('end-btn').addEventListener('click', function () {
    var b = $('end-btn');
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to end the game for everyone'; return; }
    b.dataset.sure = ''; b.textContent = 'End game now';
    act('host:close');
  });
  $('done-btn').addEventListener('click', function () {
    act('host:close', { leave: true });
    setPin(null); game = null;
    show('list');
  });

  function startTimer(ms, totalMs) {
    clearInterval(tick);
    var end = Date.now() + ms;
    var bar = $('s-bar');
    bar.style.transition = 'none';
    bar.style.width = Math.min(100, (ms / totalMs) * 100) + '%';
    void bar.offsetWidth;
    bar.style.transition = 'width ' + ms + 'ms linear';
    bar.style.width = '0%';
    function draw() {
      var left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      $('s-timer').textContent = left + 's';
      $('g-stage').classList.toggle('low', left <= 5);
      if (left <= 0) {
        clearInterval(tick);
        // safety net: tell the server time is up in case its own timer did not fire
        if (game && game.state === 'question') socket.emit('host:timeup', { pin: game.pin, index: game.index });
      }
    }
    draw();
    tick = setInterval(draw, 250);
  }
  function board(box, rows) {
    box.textContent = '';
    if (!rows.length) box.appendChild(el('p', 'muted center', 'No players'));
    rows.forEach(function (p, i) {
      var r = el('div', 'board-row' + (i === 0 ? ' first' : ''));
      r.appendChild(el('span', 'pos', i + 1));
      r.appendChild(el('span', 'nm', p.name));
      r.appendChild(el('span', 'sc', p.score.toLocaleString()));
      box.appendChild(r);
    });
  }

  function renderGame(s) {
    var prev = game;
    game = s;
    show('game');
    $('g-lobby').classList.toggle('hidden', s.state !== 'lobby');
    $('g-stage').classList.toggle('hidden', s.state !== 'question' && s.state !== 'reveal');
    $('g-final').classList.toggle('hidden', s.state !== 'ended');
    $('end-btn').classList.toggle('hidden', s.state === 'ended');

    if (s.state === 'lobby') {
      $('g-url').textContent = location.host;
      $('g-pin').textContent = s.pin;
      $('g-title').textContent = s.title;
      $('g-count').textContent = s.players.length;
      $('g-count-label').textContent = s.players.length === 1 ? 'player joined' : 'players joined';
      $('g-empty').classList.toggle('hidden', s.players.length > 0);
      var chips = $('g-players');
      chips.textContent = '';
      s.players.forEach(function (p) {
        var c = el('button', 'chip' + (p.connected ? '' : ' off'), p.name);
        c.title = 'Remove ' + p.name;
        c.addEventListener('click', function () { act('host:kick', { playerId: p.id }); });
        chips.appendChild(c);
      });
      return;
    }
    if (s.state === 'ended') {
      clearInterval(tick);
      board($('f-board'), s.leaderboard);
      $('csv-link').href = apiUrl('/games/' + s.pin + '/results.csv');
      return;
    }

    // question or reveal
    var reveal = s.state === 'reveal';
    $('s-count').textContent = 'Question ' + (s.index + 1) + ' / ' + s.total;
    $('s-pin').textContent = 'PIN ' + s.pin;
    $('s-answered').textContent = s.answered + ' / ' + s.players.length + ' answered';
    $('s-text').textContent = s.text;
    $('s-text').classList.toggle('hidden', !s.text);
    var img = $('s-image');
    if (s.image) { if (img.getAttribute('src') !== s.image) img.src = s.image; $('s-media').classList.remove('hidden'); }
    else { $('s-media').classList.add('hidden'); img.removeAttribute('src'); }
    $('g-stage').classList.toggle('revealed', reveal);
    var box = $('s-options');
    box.textContent = '';
    s.options.forEach(function (text, i) {
      var o = el('div', 'opt o' + i);
      o.appendChild(el('span', 'letter', LETTERS[i]));
      o.appendChild(el('span', 'label', text));
      if (reveal) {
        if (i === s.correct) o.classList.add('right'); else o.classList.add('dim');
        var total = s.counts.reduce(function (a, b) { return a + b; }, 0) || 1;
        var fill = el('span', 'fill'); fill.style.width = Math.round((s.counts[i] / total) * 100) + '%';
        o.insertBefore(fill, o.firstChild);
        o.appendChild(el('span', 'count', s.counts[i]));
      }
      box.appendChild(o);
    });
    if (reveal) {
      clearInterval(tick);
      $('s-timer').textContent = 'Done';
      $('g-stage').classList.remove('low');
      var bar = $('s-bar'); bar.style.transition = 'none'; bar.style.width = '0%';
      $('next-btn').textContent = s.index + 1 < s.total ? 'Next question →' : 'Show final results →';
    } else {
      $('next-btn').textContent = 'Reveal answer';
      if (!prev || prev.state !== 'question' || prev.index !== s.index) startTimer(s.remainingMs, s.time * 1000);
    }
    $('s-board-wrap').classList.add('hidden'); // the ranking is shown only on the final results screen
  }

  // ---------- boot ----------
  api('GET', '/host/me').then(function (r) { if (r.loggedIn) enter(); else show('login'); })
    .catch(function () { show('login'); });
})();
