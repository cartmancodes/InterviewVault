// Ambient motion switch. C2's scene loops forever — sun, clouds, snow, gondola,
// kite, rabbit, windmill, duck — so WCAG 2.2.2 wants a way to stop it. Every
// looping animation reads --amb, so one property parks the whole page.
//
// Three kinds of motion live on this page and --amb only reaches the first:
//   1. CSS animations       — the property, read inside each `animation` shorthand
//   2. SMIL <animateMotion> — pauseAnimations() on each <svg> root, below
//   3. JS timers            — the typing terminal, which listens for the
//      `pf-motion` event this dispatches on `document`
// A DOM event rather than a shared variable, so the two IIFEs stay independent
// and a third consumer can join without either of them knowing.
const PF_MOTION_EVENT = 'pf-motion';

(() => {
  const btn = document.getElementById('pf-motion');
  if (!btn) return;
  const body = document.body;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function apply(state) {
    body.style.setProperty('--amb', state);
    const paused = state === 'paused';
    btn.setAttribute('aria-pressed', String(paused));
    btn.querySelector('.pf-motion-icon').textContent = paused ? '▶' : '⏸';
    btn.setAttribute('aria-label', paused ? 'Resume background motion' : 'Pause background motion');
    // The gondola, the rabbit and the duck ride <animateMotion>, which is SMIL —
    // animation-play-state cannot reach it, but every <svg> root can pause its
    // own timeline. Without this the toggle would stop most of the scene and
    // leave three things moving, which is worse than not offering it.
    document.querySelectorAll('svg').forEach((svg) => {
      if (typeof svg.pauseAnimations !== 'function') return;
      paused ? svg.pauseAnimations() : svg.unpauseAnimations();
    });
    // and the timer-driven motion, which no CSS property can reach
    document.dispatchEvent(new CustomEvent(PF_MOTION_EVENT, { detail: { paused } }));
  }

  // A reduced-motion preference is not a preference we get to overrule, so the
  // stored choice is only consulted when the user has not asked for less motion.
  let state = 'running';
  if (reduced.matches) state = 'paused';
  else if (localStorage.getItem('pf-motion') === 'paused') state = 'paused';
  apply(state);

  btn.addEventListener('click', () => {
    state = state === 'paused' ? 'running' : 'paused';
    apply(state);
    try { localStorage.setItem('pf-motion', state); } catch (e) { /* private mode */ }
  });

  reduced.addEventListener('change', (e) => { if (e.matches) apply('paused'); });
})();

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

// The prompt types one line, holds, deletes and moves to the next. Under a
// reduced-motion preference the first line is simply left standing.
//
// Moving text directly under the pause button is the most distracting thing on
// the page, so it honours the button too — but it is a setTimeout chain, not a
// CSS animation, so --amb cannot reach it. It listens for the `pf-motion` event
// instead, and reads --amb once at startup because the toggle applies its stored
// state before this IIFE has had a chance to subscribe.
(() => {
  const el = document.getElementById('pf-type');
  if (!el) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const msgs = [
    '$ ping knowledge.local — 64 bytes received: curiosity alive',
    '$ uptime — 9 years in production, 0 dropped packets',
    '$ whoami — technical lead by day, side-project gremlin by night',
  ];
  let m = 0, i = msgs[0].length, deleting = false, timer = 0;

  function step() {
    const s = msgs[m];
    if (deleting) {
      i -= 3;
      if (i <= 0) { i = 0; deleting = false; m = (m + 1) % msgs.length; }
      el.textContent = msgs[m].slice(0, i) + '▌';
      timer = setTimeout(step, 24);
      return;
    }
    i++;
    if (i >= s.length) { el.textContent = s; deleting = true; timer = setTimeout(step, 2800); return; }
    el.textContent = s.slice(0, i) + '▌';
    timer = setTimeout(step, 42);
  }

  function stop() { clearTimeout(timer); timer = 0; }
  function start(delay) { stop(); timer = setTimeout(step, delay); }

  // Parking mid-word would leave a half-typed line and a cursor frozen on
  // screen, which reads as broken rather than paused. Finish the line the reader
  // is looking at, drop the cursor, and rewind the state machine to "just
  // finished typing msgs[m]" so resuming picks the loop straight back up.
  function park() {
    stop();
    el.textContent = msgs[m];
    i = msgs[m].length;
    deleting = false;
  }

  let paused = getComputedStyle(document.body).getPropertyValue('--amb').trim() === 'paused';
  if (paused) park(); else start(1600);

  document.addEventListener(PF_MOTION_EVENT, (e) => {
    const next = !!(e.detail && e.detail.paused);
    if (next === paused) return;
    paused = next;
    if (paused) park(); else start(1200);
  });

  // a background tab should not keep a 42ms timer alive — but a bfcache restore
  // fires pageshow and must find a live terminal, not the corpse of one
  addEventListener('pagehide', stop);
  addEventListener('pageshow', (e) => { if (e.persisted && !paused) start(1200); });
})();

// Sections settle into place as they come up. One observer, and each section is
// released the moment it has been revealed.
(() => {
  const secs = document.querySelectorAll('main section');
  if (!secs.length || !('IntersectionObserver' in window)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  secs.forEach((s) => s.classList.add('pf-reveal'));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('pf-shown');
      io.unobserve(e.target);
    });
  }, { threshold: 0.1 });
  secs.forEach((s) => io.observe(s));
})();
