/* InterviewVault — Packet Runner, the front-page mini-game.
 *
 * Snake on a 20x12 grid: guide the stream, deliver packets, don't drop the
 * connection. Vanilla and dependency-free like the rest of the client code.
 * The game is inert until an explicit START, so arrows scroll the page as
 * normal and prefers-reduced-motion users see a still board.
 */
(function () {
  'use strict';

  var board = document.getElementById('pr-board');
  if (!board) return;

  var COLS = 20, ROWS = 12, TICK_MS = 150;
  var foodEl = document.getElementById('pr-food');
  var overlay = document.getElementById('pr-overlay');
  var ovTitle = document.getElementById('pr-title');
  var ovSub = document.getElementById('pr-sub');
  var ovBtn = document.getElementById('pr-btn');
  var scoreEl = document.getElementById('pr-score');

  // The board is fluid below 440px, so the cell is measured, not assumed.
  // At the design width of 400px this is exactly the spec's 20px cell.
  var cell = 20;
  function measure() {
    cell = board.clientWidth / COLS;
    board.style.setProperty('--cell', cell + 'px');
  }

  var snake = [], dir, pendingDir, food, score = 0, running = false, timer = null, segEls = [];

  function place(el, x, y, inset) {
    el.style.left = (x * cell + cell * inset) + 'px';
    el.style.top = (y * cell + cell * inset) + 'px';
  }

  function spawnFood() {
    var p;
    do { p = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) }; }
    while (snake.some(function (s) { return s.x === p.x && s.y === p.y; }));
    return p;
  }

  function draw() {
    while (segEls.length < snake.length) {
      var el = document.createElement('div');
      el.className = 'pr-seg';
      board.insertBefore(el, foodEl);
      segEls.push(el);
    }
    while (segEls.length > snake.length) board.removeChild(segEls.pop());
    for (var i = 0; i < snake.length; i++) {
      segEls[i].className = i === 0 ? 'pr-seg head' : 'pr-seg';
      place(segEls[i], snake[i].x, snake[i].y, 0.05);
    }
    place(foodEl, food.x, food.y, 0.225);
    scoreEl.textContent = score;
  }

  function start() {
    snake = [{ x: 9, y: 6 }, { x: 8, y: 6 }, { x: 7, y: 6 }];
    dir = { x: 1, y: 0 };
    pendingDir = dir;
    food = spawnFood();
    score = 0;
    running = true;
    overlay.style.display = 'none';
    // the board only stops passing gestures through to the page while playing
    board.classList.add('is-running');
    clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    draw();
  }

  function gameOver() {
    running = false;
    tracking = false;
    board.classList.remove('is-running');
    clearInterval(timer);
    ovTitle.textContent = 'CONNECTION DROPPED';
    ovSub.textContent = 'connection dropped — ' + score + ' packet' + (score === 1 ? '' : 's') + ' delivered';
    ovBtn.textContent = 'RECONNECT';
    overlay.style.display = 'flex';
    ovBtn.focus();
  }

  function tick() {
    dir = pendingDir;
    var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    var hitSelf = snake.some(function (s) { return s.x === head.x && s.y === head.y; });
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS || hitSelf) return gameOver();
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score++;
      food = spawnFood();
    } else {
      snake.pop();
    }
    draw();
  }

  /* ── steering ──────────────────────────────────────────────
   * Keys, the on-screen pad and swipes all funnel through steer(), so the
   * "no reversing into yourself" rule has exactly one implementation. */
  function steer(dx, dy) {
    if (!running) return;
    if (dx === -dir.x && dy === -dir.y) return;
    pendingDir = { x: dx, y: dy };
  }

  var KEYS = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
  };
  window.addEventListener('keydown', function (e) {
    var v = KEYS[e.key];
    // only capture keys while a run is live, so the page scrolls as normal
    if (!v || !running) return;
    e.preventDefault();
    steer(v[0], v[1]);
  });

  // Touch steering: tap where the stream should go. The board is the control —
  // moving horizontally, a tap above or below the head turns that way; moving
  // vertically, a tap to either side turns. The projection onto the free axis
  // means every tap is a legal turn, never a refused reversal.
  function steerToward(clientX, clientY) {
    var r = board.getBoundingClientRect();
    var headX = r.left + (snake[0].x + 0.5) * cell;
    var headY = r.top + (snake[0].y + 0.5) * cell;
    if (dir.x !== 0) {
      var dy = clientY - headY;
      if (Math.abs(dy) > cell / 2) steer(0, dy > 0 ? 1 : -1);
    } else {
      var dx = clientX - headX;
      if (Math.abs(dx) > cell / 2) steer(dx > 0 ? 1 : -1, 0);
    }
  }

  // Swipes still work for players who steer by flick. A touch that never
  // travels past the threshold is a tap and steers toward its point instead.
  var SWIPE = 24, sx = 0, sy = 0, tracking = false, swiped = false;
  board.addEventListener('touchstart', function (e) {
    if (!running) return;
    var t = e.changedTouches[0];
    sx = t.clientX; sy = t.clientY; tracking = true; swiped = false;
  }, { passive: true });
  board.addEventListener('touchmove', function (e) {
    if (!running || !tracking) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < SWIPE && Math.abs(dy) < SWIPE) return;
    e.preventDefault(); // the board only claims the gesture once it is a swipe
    swiped = true;
    if (Math.abs(dx) > Math.abs(dy)) steer(dx > 0 ? 1 : -1, 0);
    else steer(0, dy > 0 ? 1 : -1);
    sx = t.clientX; sy = t.clientY; // re-origin, so one drag can turn twice
  }, { passive: false });
  board.addEventListener('touchend', function (e) {
    if (running && tracking && !swiped) {
      var t = e.changedTouches[0];
      steerToward(t.clientX, t.clientY);
    }
    tracking = false;
  }, { passive: true });

  window.addEventListener('resize', function () {
    measure();
    if (snake.length) draw();
    else place(foodEl, food.x, food.y, 0.225);
  });

  ovBtn.addEventListener('click', start);

  // idle state: one pulsing packet so the board reads as alive, not broken
  measure();
  food = { x: 14, y: 6 };
  place(foodEl, food.x, food.y, 0.225);
})();
