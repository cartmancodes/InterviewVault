// Library filtering: text search + collection chips. No tracking, no state persisted.
(function () {
  var q = document.getElementById('q');
  var rows = document.getElementById('rows');
  var none = document.getElementById('none');
  if (!q || !rows) return;

  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var secs = Array.prototype.slice.call(rows.querySelectorAll('.sec'));
  var active = null;

  function apply() {
    var term = q.value.trim().toLowerCase();
    var shown = 0;
    secs.forEach(function (sec) {
      var hitsInSec = 0;
      Array.prototype.forEach.call(sec.querySelectorAll('.row'), function (row) {
        var okSec = !active || sec.dataset.sec === active;
        var okTerm = !term || row.dataset.t.indexOf(term) > -1;
        var show = okSec && okTerm;
        row.hidden = !show;
        if (show) hitsInSec++;
      });
      sec.hidden = hitsInSec === 0;
      shown += hitsInSec;
    });
    none.hidden = shown > 0;
  }

  q.addEventListener('input', apply);
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      active = active === c.dataset.f ? null : c.dataset.f;
      chips.forEach(function (o) { o.setAttribute('aria-pressed', String(o.dataset.f === active)); });
      apply();
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); q.select(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; q.blur(); apply(); }
  });
})();
