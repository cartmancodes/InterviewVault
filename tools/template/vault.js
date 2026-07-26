/* InterviewVault — practice sidecar.
 *
 * Everything is client-side. Progress is one JSON blob in localStorage keyed by
 * doc slug; challenge definitions are inlined by the build as JSON. Scores only,
 * no wrong-answer history, no network.
 */
(function () {
  'use strict';

  var KEY = 'iv.progress.v1';
  var TIERS = [
    { id: 'mid', label: 'Mid' },
    { id: 'senior', label: 'Senior' },
    { id: 'staff', label: 'Staff+' },
  ];

  /* ── store ─────────────────────────────────────────────── */
  var store = {
    read: function () {
      try {
        var raw = localStorage.getItem(KEY);
        var d = raw ? JSON.parse(raw) : null;
        if (!d || d.v !== 1) throw 0;
        return d;
      } catch (e) {
        return { v: 1, xp: 0, tier: 'senior', docs: {}, streak: { last: null, n: 0 } };
      }
    },
    write: function (d) {
      try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* private mode */ }
    },
    doc: function (d, slug) {
      if (!d.docs[slug]) d.docs[slug] = { cp: {} };
      if (!d.docs[slug].cp) d.docs[slug].cp = {};
      return d.docs[slug];
    },
  };

  function today() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }

  function touchStreak(d) {
    var t = today();
    if (d.streak.last === t) return;
    var y = new Date(Date.now() - 86400000);
    var yStr = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
    d.streak.n = d.streak.last === yStr ? d.streak.n + 1 : 1;
    d.streak.last = t;
  }

  // levels widen as they go: 0,120,300,560,900,...
  function levelOf(xp) {
    var lv = 1, need = 120, acc = 0;
    while (xp >= acc + need && lv < 20) { acc += need; need = Math.round(need * 1.35); lv++; }
    return { level: lv, into: xp - acc, need: need };
  }

  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* ── mechanics ─────────────────────────────────────────── */
  // Each returns a node and calls done(scoreFraction) once resolved.

  function mTriage(cp, done) {
    var wrap = el('div', 'mech');
    wrap.appendChild(el('p', 'mech-prompt', cp.prompt));

    var timerBar = null, timerId = null, left = cp.timeLimitSec || 0;
    if (left && window.__ivTimed) {
      timerBar = el('div', 'mech-timer');
      var fill = el('i');
      timerBar.appendChild(fill);
      wrap.appendChild(timerBar);
      var total = left;
      timerId = setInterval(function () {
        left--;
        fill.style.width = Math.max(0, (left / total) * 100) + '%';
        if (left <= 0) { clearInterval(timerId); finish(true); }
      }, 1000);
    }

    var answers = {};
    var list = el('div', 'triage');
    cp.items.forEach(function (item, i) {
      var row = el('div', 'triage-row');
      row.appendChild(el('span', 'triage-t', item.text));
      var btns = el('span', 'triage-btns');
      ['core', 'below'].forEach(function (v) {
        var b = el('button', 'tg', v === 'core' ? 'core' : 'below');
        b.type = 'button';
        b.addEventListener('click', function () {
          answers[i] = v;
          btns.querySelectorAll('.tg').forEach(function (o) { o.classList.remove('on'); });
          b.classList.add('on');
          if (Object.keys(answers).length === cp.items.length) finish(false);
        });
        btns.appendChild(b);
      });
      row.appendChild(btns);
      list.appendChild(row);
    });
    wrap.appendChild(list);

    var finished = false;
    function finish(timeout) {
      if (finished) return;
      finished = true;
      if (timerId) clearInterval(timerId);
      var right = 0;
      cp.items.forEach(function (item, i) {
        var row = list.children[i];
        var ok = answers[i] === item.answer;
        if (answers[i]) row.classList.add(ok ? 'ok' : 'no');
        else row.classList.add('miss');
        row.querySelectorAll('.tg').forEach(function (b) {
          if (b.textContent === item.answer) b.classList.add('truth');
          b.disabled = true;
        });
        if (ok) right++;
      });
      var frac = right / cp.items.length;
      wrap.appendChild(el('p', 'mech-note', (timeout ? 'Time. ' : '') + right + ' of ' + cp.items.length + ' placed correctly.'));
      done(frac);
    }
    return wrap;
  }

  function mRecall(cp, done) {
    var wrap = el('div', 'mech');
    wrap.appendChild(el('p', 'mech-prompt', cp.prompt));
    var ticked = 0;
    var list = el('div', 'recall');
    cp.items.forEach(function (item) {
      var row = el('label', 'recall-row');
      var box = el('input');
      box.type = 'checkbox';
      box.addEventListener('change', function () {
        ticked += box.checked ? 1 : -1;
        row.classList.toggle('on', box.checked);
        btn.disabled = ticked === 0;
      });
      row.appendChild(box);
      row.appendChild(el('span', null, item.text));
      list.appendChild(row);
    });
    wrap.appendChild(list);
    var btn = el('button', 'mech-go', 'Bank ' + '→');
    btn.type = 'button';
    btn.disabled = true;
    btn.addEventListener('click', function () {
      btn.remove();
      var frac = ticked / cp.items.length;
      wrap.appendChild(el('p', 'mech-note', ticked + ' of ' + cp.items.length + ' you can defend. The rest are what to reread.'));
      done(frac);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function mDuel(cp, done) {
    var wrap = el('div', 'mech');
    wrap.appendChild(el('p', 'mech-prompt', cp.prompt));
    var picked = null;
    var opts = el('div', 'duel');
    cp.options.forEach(function (o) {
      var b = el('button', 'duel-opt');
      b.type = 'button';
      b.appendChild(el('b', null, o.label));
      if (o.sub) b.appendChild(el('span', 'duel-sub', o.sub));
      b.addEventListener('click', function () {
        if (picked) return;
        picked = o;
        opts.querySelectorAll('.duel-opt').forEach(function (x, i) {
          x.disabled = true;
          x.classList.add(cp.options[i].correct ? 'right' : 'wrong');
        });
        b.classList.add('picked');
        wrap.appendChild(el('p', 'mech-verdict', o.verdict));
        if (cp.defend) defend(o.correct);
        else done(o.correct ? 1 : 0.35);
      });
      opts.appendChild(b);
    });
    wrap.appendChild(opts);

    function defend(pickedRight) {
      var d = cp.defend;
      var box = el('div', 'defend');
      box.appendChild(el('p', 'mech-prompt', d.prompt));
      var chosen = {};
      d.options.forEach(function (o, i) {
        var row = el('label', 'recall-row');
        var cbx = el('input');
        cbx.type = 'checkbox';
        cbx.addEventListener('change', function () { chosen[i] = cbx.checked; });
        row.appendChild(cbx);
        row.appendChild(el('span', null, o.label));
        box.appendChild(row);
      });
      var go = el('button', 'mech-go', 'Commit');
      go.type = 'button';
      go.addEventListener('click', function () {
        go.remove();
        var right = 0;
        d.options.forEach(function (o, i) {
          var row = box.children[i + 1];
          var want = !!o.correct, got = !!chosen[i];
          row.classList.add(want === got ? 'ok' : 'no');
          row.querySelector('input').disabled = true;
          if (want === got) right++;
        });
        if (d.explain) box.appendChild(el('p', 'mech-note', d.explain));
        var frac = (right / d.options.length) * 0.5 + (pickedRight ? 0.5 : 0.15);
        done(Math.min(1, frac));
      });
      box.appendChild(go);
      wrap.appendChild(box);
    }
    return wrap;
  }

  function mLadder(cp, done) {
    var wrap = el('div', 'mech');
    wrap.appendChild(el('p', 'mech-prompt', cp.prompt));
    var step = 0, right = 0;
    var host = el('div', 'ladder');
    wrap.appendChild(host);

    function rung() {
      if (step >= cp.rungs.length) {
        if (cp.explain) wrap.appendChild(el('p', 'mech-note', cp.explain));
        done(right / cp.rungs.length);
        return;
      }
      var r = cp.rungs[step];
      var row = el('div', 'rung');
      row.appendChild(el('div', 'rung-q', r.q));
      var choices = el('div', 'rung-choices');
      r.choices.forEach(function (c, i) {
        var b = el('button', 'rung-c', c);
        b.type = 'button';
        b.addEventListener('click', function () {
          choices.querySelectorAll('.rung-c').forEach(function (x, j) {
            x.disabled = true;
            if (j === r.answer) x.classList.add('right');
          });
          if (i === r.answer) { right++; b.classList.add('picked'); }
          else b.classList.add('wrong');
          if (r.note) row.appendChild(el('div', 'rung-note', r.note));
          step++;
          setTimeout(rung, 260);
        });
        choices.appendChild(b);
      });
      row.appendChild(choices);
      host.appendChild(row);
    }
    rung();
    return wrap;
  }

  function mBuilder(cp, done) {
    var wrap = el('div', 'mech');
    wrap.appendChild(el('p', 'mech-prompt', cp.prompt));
    wrap.appendChild(el('p', 'mech-hint', 'Pick a component, then the position it belongs in. Click a filled slot to clear it.'));

    var placed = new Array(cp.slots.length).fill(null);
    var active = null;

    var track = el('div', 'build-track');
    cp.slots.forEach(function (s, i) {
      var slot = el('button', 'slot');
      slot.type = 'button';
      slot.dataset.i = i;
      slot.dataset.n = i + 1;
      slot.setAttribute('aria-label', 'Position ' + (i + 1));
      slot.textContent = '';
      slot.addEventListener('click', function () {
        if (!active) {
          if (placed[i]) { placed[i] = null; paint(); }
          return;
        }
        placed[i] = active;
        active = null;
        paint();
      });
      track.appendChild(slot);
      if (i < cp.slots.length - 1) track.appendChild(el('span', 'build-arrow', '→'));
    });
    wrap.appendChild(track);

    var pal = el('div', 'palette');
    cp.palette.forEach(function (name) {
      var b = el('button', 'chip', name);
      b.type = 'button';
      b.addEventListener('click', function () {
        active = active === name ? null : name;
        paint();
      });
      pal.appendChild(b);
    });
    wrap.appendChild(pal);

    function paint() {
      track.querySelectorAll('.slot').forEach(function (s, i) {
        s.textContent = placed[i] || '';
        s.classList.toggle('filled', !!placed[i]);
      });
      pal.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('on', c.textContent === active);
        c.classList.toggle('used', placed.indexOf(c.textContent) > -1);
      });
      check.disabled = placed.indexOf(null) > -1;
    }

    var check = el('button', 'mech-go', 'Check design');
    check.type = 'button';
    check.disabled = true;
    check.addEventListener('click', function () {
      check.remove();
      var right = 0;
      track.querySelectorAll('.slot').forEach(function (s, i) {
        var ok = placed[i] === cp.slots[i].accept;
        s.classList.add(ok ? 'ok' : 'no');
        if (!ok) s.title = 'expected ' + cp.slots[i].accept;
        if (ok) right++;
      });
      pal.querySelectorAll('.chip').forEach(function (c) { c.disabled = true; });
      if (cp.explain) wrap.appendChild(el('p', 'mech-note', cp.explain));
      done(right / cp.slots.length);
    });
    wrap.appendChild(check);
    paint();
    return wrap;
  }

  function mBottleneck(cp, done) {
    var wrap = el('div', 'mech');
    wrap.appendChild(el('p', 'mech-prompt', cp.prompt));
    var grid = el('div', 'dash');
    var answered = false;
    cp.cards.forEach(function (c) {
      var card = el('button', 'dash-card state-' + (c.state || 'ok'));
      card.type = 'button';
      card.appendChild(el('div', 'dash-name', c.name));
      card.appendChild(el('div', 'dash-metric', c.metric));
      if (c.delta) card.appendChild(el('div', 'dash-delta', c.delta));
      card.addEventListener('click', function () {
        if (answered) return;
        answered = true;
        var ok = c.name === cp.answer;
        grid.querySelectorAll('.dash-card').forEach(function (x) { x.disabled = true; });
        card.classList.add(ok ? 'picked-ok' : 'picked-no');
        grid.querySelectorAll('.dash-card').forEach(function (x, i) {
          if (cp.cards[i].name === cp.answer) x.classList.add('truth');
        });
        if (!ok && cp.wrong && cp.wrong[c.name]) wrap.appendChild(el('p', 'mech-verdict', cp.wrong[c.name]));
        wrap.appendChild(el('p', 'mech-note', cp.explain));
        done(ok ? 1 : 0.25);
      });
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  var MECHANICS = {
    triage: mTriage, recall: mRecall, duel: mDuel,
    ladder: mLadder, builder: mBuilder, bottleneck: mBottleneck,
  };

  // How much horizontal room each mechanic actually needs. The builder lays a
  // pipeline out left-to-right and the dashboard is a grid of cards; both are
  // unreadable in a 210px rail, so they open wider.
  var WIDTH = { builder: 'wide', bottleneck: 'wide' };

  /* ── focused overlay ───────────────────────────────────── */
  function openMechanic(cp, onDone, returnFocusTo) {
    var overlay = el('div', 'mech-overlay');
    var panel = el('div', 'mech-panel' + (WIDTH[cp.type] === 'wide' ? ' wide' : ''));
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', cp.title);
    panel.tabIndex = -1;

    var head = el('div', 'mp-head');
    var titles = el('div', 'mp-titles');
    titles.appendChild(el('span', 'mp-eyebrow', cp.tier + ' · ' + (cp.xp || 50) + ' XP'));
    titles.appendChild(el('h3', null, cp.title));
    head.appendChild(titles);
    var close = el('button', 'mp-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    head.appendChild(close);
    panel.appendChild(head);

    var body = el('div', 'mp-body');
    panel.appendChild(body);

    var foot = el('div', 'mp-foot');
    var hint = el('span', 'mp-hint', 'Esc to close');
    foot.appendChild(hint);
    panel.appendChild(foot);

    var make = MECHANICS[cp.type];
    if (make) {
      body.appendChild(make(cp, function (frac) {
        onDone(frac);
        hint.textContent = 'Scored ' + Math.round(frac * 100) + '%';
        var doneBtn = el('button', 'mp-done', 'Done');
        doneBtn.type = 'button';
        doneBtn.addEventListener('click', shut);
        foot.appendChild(doneBtn);
        doneBtn.focus();
      }));
    } else {
      body.appendChild(el('p', 'mech-note', 'Not available yet.'));
    }

    function shut() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      document.body.classList.remove('mech-open');
      if (returnFocusTo) returnFocusTo.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') shut();
    }
    close.addEventListener('click', shut);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) shut(); });
    document.addEventListener('keydown', onKey);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.body.classList.add('mech-open');
    panel.focus();
  }

  /* ── sidecar ───────────────────────────────────────────── */
  function boot() {
    var dataEl = document.getElementById('iv-challenges');
    var host = document.getElementById('iv-sidecar');
    if (!dataEl || !host) return;

    var data;
    try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
    if (!data.checkpoints || !data.checkpoints.length) return;

    var db = store.read();
    var slug = data.slug;
    var tier = db.tier || 'senior';
    window.__ivTimed = false;

    function save() { store.write(db); }

    function award(cpId, xp, frac) {
      var doc = store.doc(db, slug);
      var prev = doc.cp[cpId];
      var score = Math.round(frac * 100) / 100;
      // only ever improve a checkpoint, and only pay the delta in xp
      var prevScore = prev ? prev.score : 0;
      if (!prev || score > prevScore) {
        doc.cp[cpId] = { done: true, score: score };
        db.xp += Math.round(xp * (score - prevScore));
      } else if (!prev) {
        doc.cp[cpId] = { done: true, score: score };
      }
      touchStreak(db);
      save();
      render();
    }

    function render() {
      host.innerHTML = '';
      var doc = store.doc(db, slug);

      var head = el('div', 'sc-head');
      head.appendChild(el('span', 'sc-eyebrow', 'Practice'));
      var timed = el('label', 'sc-timed');
      var tbox = el('input');
      tbox.type = 'checkbox';
      tbox.checked = !!window.__ivTimed;
      tbox.addEventListener('change', function () { window.__ivTimed = tbox.checked; });
      timed.appendChild(tbox);
      timed.appendChild(el('span', null, 'Timed'));
      head.appendChild(timed);
      host.appendChild(head);

      var lv = levelOf(db.xp);
      var meter = el('div', 'sc-level');
      meter.appendChild(el('div', 'sc-lv', 'L' + lv.level));
      var bar = el('div', 'sc-bar');
      var fill = el('i');
      fill.style.width = Math.round((lv.into / lv.need) * 100) + '%';
      bar.appendChild(fill);
      var meta = el('div', 'sc-meta');
      meta.appendChild(bar);
      meta.appendChild(el('span', 'sc-xp', db.xp.toLocaleString() + ' XP'));
      meter.appendChild(meta);
      host.appendChild(meter);

      var tabs = el('div', 'sc-tabs');
      TIERS.forEach(function (t) {
        var b = el('button', 'sc-tab' + (t.id === tier ? ' on' : ''), t.label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(t.id === tier));
        b.addEventListener('click', function () { tier = t.id; db.tier = t.id; save(); render(); });
        tabs.appendChild(b);
      });
      host.appendChild(tabs);

      var order = { mid: 0, senior: 1, staff: 2 };
      var visible = data.checkpoints.filter(function (cp) { return order[cp.tier] <= order[tier]; });
      var doneN = visible.filter(function (cp) { return doc.cp[cp.id]; }).length;

      host.appendChild(el('div', 'sc-track',
        TIERS.filter(function (t) { return t.id === tier; })[0].label + ' track · ' +
        doneN + ' of ' + visible.length + ' checkpoints'));

      var list = el('div', 'sc-list');
      visible.forEach(function (cp) {
        var rec = doc.cp[cp.id];
        var item = el('div', 'sc-cp' + (rec ? ' done' : ''));

        var btn = el('button', 'sc-cp-head');
        btn.type = 'button';
        var dot = el('span', 'sc-dot');
        btn.appendChild(dot);
        var label = el('span', 'sc-cp-t');
        label.appendChild(el('b', null, cp.title));
        label.appendChild(el('span', 'sc-cp-sub', rec
          ? Math.round(rec.score * 100) + '% · ' + cp.tier
          : (cp.xp || 50) + ' XP · ' + cp.tier));
        btn.appendChild(label);
        btn.appendChild(el('span', 'sc-go', rec ? 'Retry' : 'Start'));
        item.appendChild(btn);

        btn.addEventListener('click', function () {
          // the sidecar is the HUD; the mechanic itself gets a room of its own
          openMechanic(cp, function (frac) { award(cp.id, cp.xp || 50, frac); }, btn);
        });

        list.appendChild(item);
      });
      host.appendChild(list);

      if (data.levels && data.levels.length) {
        var lvls = el('details', 'sc-levels');
        lvls.appendChild(el('summary', null, 'Deep dives · ' + data.levels.length));
        var ol = el('ol');
        data.levels.forEach(function (t) { ol.appendChild(el('li', null, t)); });
        lvls.appendChild(ol);
        host.appendChild(lvls);
      }

      var foot = el('div', 'sc-foot');
      foot.appendChild(el('span', null, db.streak.n > 0 ? db.streak.n + '-day streak' : 'Start a streak'));
      var map = el('a', null, 'Vault map');
      map.href = '/progress/';
      foot.appendChild(map);
      host.appendChild(foot);
    }

    render();

    // mobile: the sidecar becomes a bottom sheet
    var opener = document.getElementById('iv-sheet-open');
    if (opener) {
      opener.hidden = false;
      opener.addEventListener('click', function () {
        document.body.classList.toggle('sheet-open');
        opener.setAttribute('aria-expanded', String(document.body.classList.contains('sheet-open')));
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
