/* Vault map — reads the same localStorage blob the sidecar writes. */
(function () {
  'use strict';
  var KEY = 'iv.progress.v1';

  function read() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY));
      if (!d || d.v !== 1) throw 0;
      return d;
    } catch (e) {
      return { v: 1, xp: 0, docs: {}, streak: { last: null, n: 0 } };
    }
  }
  function levelOf(xp) {
    var lv = 1, need = 120, acc = 0;
    while (xp >= acc + need && lv < 20) { acc += need; need = Math.round(need * 1.35); lv++; }
    return lv;
  }
  var el = function (t, c, x) { var n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

  var db = read();
  var cards = Array.prototype.slice.call(document.querySelectorAll('.vault-card'));

  var started = 0, cleared = 0, checkpoints = 0;
  cards.forEach(function (card) {
    var slug = card.dataset.slug;
    var total = +card.dataset.total;
    var rec = db.docs[slug];
    var done = rec ? Object.keys(rec.cp || {}).length : 0;
    checkpoints += done;
    if (done) started++;
    if (done >= total) cleared++;
    var pct = total ? Math.round((done / total) * 100) : 0;
    card.querySelector('.vc-bar i').style.width = pct + '%';
    card.querySelector('.vc-n').textContent = done + ' / ' + total;
    card.classList.toggle('has', done > 0);
    card.classList.toggle('full', total > 0 && done >= total);
  });

  var stats = document.getElementById('vm-stats');
  if (stats) {
    [[db.xp.toLocaleString(), 'XP'], ['L' + levelOf(db.xp), 'Level'],
     [started + '/' + cards.length, 'Docs started'], [cleared, 'Docs cleared'],
     [checkpoints, 'Checkpoints']].forEach(function (p) {
      var s = el('div', 'stat');
      s.appendChild(el('b', null, String(p[0])));
      s.appendChild(el('span', null, p[1]));
      stats.appendChild(s);
    });
  }

  // last 12 weeks, most recent day last
  var streak = document.getElementById('vm-streak');
  if (streak) {
    var last = db.streak && db.streak.last;
    var n = (db.streak && db.streak.n) || 0;
    var head = el('div', 'streak-head', n > 0 ? n + '-day streak' : 'No streak yet');
    streak.appendChild(head);
    var row = el('div', 'streak-row');
    for (var i = 83; i >= 0; i--) {
      var d = new Date(Date.now() - i * 86400000);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      var on = last && i < n && key <= last;
      var cell = el('span', 'streak-cell' + (on ? ' on' : ''));
      cell.title = key;
      row.appendChild(cell);
    }
    streak.appendChild(row);
  }

  var reset = document.getElementById('vm-reset');
  if (reset) {
    reset.addEventListener('click', function () {
      if (!confirm('Clear practice progress for every doc? This cannot be undone.')) return;
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      location.reload();
    });
  }
})();
