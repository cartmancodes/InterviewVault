// The bus drives the career road. Its distance along the lane tracks how far the
// reader has scrolled the road through the viewport, and it banks into the
// curves by sampling a second point just ahead for the tangent.
//
// This is scroll-linked motion, which is what prefers-reduced-motion exists to
// suppress — under that setting the listeners are never attached and the bus is
// parked at the terminus instead. The road, the stops and the dashes all still
// render, so nothing is lost but the movement.
(() => {
  const wrap = document.querySelector('.pf-road');
  const lane = document.getElementById('pf-lane');
  const bus = document.getElementById('pf-bus');
  if (!wrap || !lane || !bus) return;

  const len = lane.getTotalLength();
  if (!len) return;

  function park(dist) {
    const at = lane.getPointAtLength(dist);
    const ahead = lane.getPointAtLength(Math.min(len, dist + 2));
    const angle = Math.atan2(ahead.y - at.y, ahead.x - at.x) * 180 / Math.PI;
    bus.setAttribute('transform', `translate(${at.x},${at.y}) rotate(${angle - 90})`);
  }

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { park(len); return; }

  function drive() {
    const box = wrap.getBoundingClientRect();
    // 0 while the road's top edge is still below 72% of the viewport height, 1
    // once the terminus has come up to meet it
    const p = (innerHeight * 0.72 - box.top) / Math.max(1, box.height - 140);
    park(Math.max(1, Math.min(1, Math.max(0, p)) * len));
  }

  addEventListener('scroll', drive, { passive: true });
  addEventListener('resize', drive);
  drive();
  // web fonts and the polaroid can reflow the page after first paint
  setTimeout(drive, 400);
})();
