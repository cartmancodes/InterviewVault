// Doc page: highlight the in-page TOC entry for the section currently on screen.
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var map = {};
  links.forEach(function (a) {
    var el = document.getElementById(decodeURIComponent(a.hash.slice(1)));
    if (el) map[el.id] = a;
  });
  var visible = new Set();
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) visible.add(en.target.id); else visible.delete(en.target.id);
    });
    var first = Object.keys(map).filter(function (id) { return visible.has(id); })[0];
    links.forEach(function (a) { a.classList.remove('active'); });
    if (first && map[first]) map[first].classList.add('active');
  }, { rootMargin: '-80px 0px -70% 0px' });
  Object.keys(map).forEach(function (id) { obs.observe(document.getElementById(id)); });
})();
