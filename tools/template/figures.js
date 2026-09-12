// Figures are complete, readable documents before this progressive enhancement.
(() => {
  const figures = [...document.querySelectorAll('.content-figure')];
  if (!figures.length) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const players = new Set();
  let activePlayer = null;

  function enhanceSteps(figure) {
    const data = figure.querySelector('.figure-steps');
    if (!data) return;
    let steps;
    try { steps = JSON.parse(data.textContent); } catch { return; }
    if (!Array.isArray(steps) || !steps.length) return;
    const groups = [...figure.querySelectorAll('[data-step-key]')];
    if (!groups.length || steps.some(step => !Array.isArray(step.focus) || step.focus.some(key => !groups.some(group => group.dataset.stepKey === key)))) return;
    let index = -1, timer = null;
    const player = document.createElement('div');
    player.className = 'figure-player';
    player.innerHTML = `<div class="figure-controls" role="group" aria-label="Diagram walkthrough controls">
      <button type="button" data-action="play">Play walkthrough</button>
      <button type="button" data-action="previous">Previous</button>
      <button type="button" data-action="next">Next step</button>
      <button type="button" data-action="reset">Show all</button>
      <span class="figure-step-count"></span></div>
      <div class="figure-step-text" aria-live="polite" aria-atomic="true"></div>
      <p class="figure-motion-note" hidden>Reduced motion is on. Use Next step to explore at your own pace.</p>`;
    figure.querySelector('figcaption').after(player);
    const button = action => player.querySelector(`[data-action="${action}"]`);
    const text = player.querySelector('.figure-step-text');
    const count = player.querySelector('.figure-step-count');
    const api = { pause };
    players.add(api);
    function pause() {
      window.clearTimeout(timer);
      timer = null;
      button('play').textContent = index === steps.length - 1 ? 'Replay' : 'Play walkthrough';
      if (activePlayer === api) activePlayer = null;
    }
    function display() {
      figure.classList.toggle('is-stepping', index >= 0);
      const step = steps[index];
      groups.forEach(group => group.classList.toggle('is-current', !!step?.focus.includes(group.dataset.stepKey)));
      text.replaceChildren();
      if (step) {
        const title = document.createElement('strong');
        title.textContent = step.title;
        text.append(title, document.createTextNode(step.description));
      } else text.textContent = 'Start the walkthrough to follow one step at a time. The complete diagram is shown above.';
      count.textContent = step ? `Step ${index + 1} of ${steps.length}` : `${steps.length} steps · overview`;
      button('previous').disabled = index < 0;
      button('next').disabled = index === steps.length - 1;
      button('reset').disabled = index < 0;
      if (!timer) button('play').textContent = index === steps.length - 1 ? 'Replay' : 'Play walkthrough';
    }
    function schedule() {
      // Give each explanation time to be read; playback is finite and opt-in.
      const delay = Math.max(4500, steps[index].description.split(/\s+/).length * 270);
      timer = window.setTimeout(() => {
        if (index >= steps.length - 1) { pause(); return; }
        index++;
        display();
        schedule();
      }, delay);
    }
    button('play').addEventListener('click', () => {
      if (timer) { pause(); return; }
      if (reduced.matches) return;
      activePlayer?.pause();
      activePlayer = api;
      if (index < 0 || index === steps.length - 1) index = 0;
      display();
      button('play').textContent = 'Pause';
      schedule();
    });
    button('next').addEventListener('click', () => { pause(); index = Math.min(index + 1, steps.length - 1); display(); });
    button('previous').addEventListener('click', () => { pause(); index = Math.max(-1, index - 1); display(); });
    button('reset').addEventListener('click', () => { pause(); index = -1; display(); });
    function motionPreference() {
      if (reduced.matches) pause();
      button('play').hidden = reduced.matches;
      player.querySelector('.figure-motion-note').hidden = !reduced.matches;
    }
    reduced.addEventListener('change', motionPreference);
    motionPreference();
    display();
    new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) pause();
    }).observe(figure);
  }
  figures.forEach(enhanceSteps);
  document.addEventListener('visibilitychange', () => { if (document.hidden) players.forEach(player => player.pause()); });

  // Move the original figure into a native dialog: SVG IDs stay unique, and
  // walkthrough state survives closing. The link remains a no-JavaScript fallback.
  if (typeof HTMLDialogElement === 'undefined') return;
  const dialog = document.createElement('dialog');
  dialog.className = 'figure-dialog';
  dialog.setAttribute('aria-label', 'Full-size figure');
  dialog.innerHTML = `<div class="figure-dialog-bar"><strong>Full-size figure</strong>
    <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
    <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
    <button type="button" data-zoom="fit">Fit width</button>
    <button type="button" data-close>Close <span aria-hidden="true">×</span></button></div>`;
  document.body.append(dialog);
  let current = null, placeholder = null, trigger = null, width = 0, previousOverflow = '';
  const setWidth = value => {
    width = value;
    current.style.setProperty('--figure-width', width ? `${width}px` : '100%');
  };
  figures.forEach(figure => figure.querySelector('.figure-expand').addEventListener('click', event => {
    event.preventDefault();
    players.forEach(player => player.pause());
    current = figure;
    trigger = event.currentTarget;
    placeholder = document.createComment('figure location');
    figure.before(placeholder);
    dialog.append(figure);
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.querySelector('.figure-dialog-bar strong').textContent = figure.querySelector('.figure-heading strong').textContent;
    dialog.showModal();
    const viewport = figure.querySelector('.figure-viewport');
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', 'Enlarged diagram. Use arrow keys to scroll.');
    // Start at a readable native width rather than shrinking a dense diagram to a phone.
    const svg = figure.querySelector('svg');
    const img = figure.querySelector('img');
    const nativeWidth = svg?.viewBox?.baseVal?.width || img?.naturalWidth || 1000;
    setWidth(Math.max(800, Math.min(2400, nativeWidth)));
    dialog.querySelector('[data-close]').focus();
  }));
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => {
    const basis = width || current.querySelector('.figure-viewport').clientWidth - 36;
    setWidth(button.dataset.zoom === 'fit' ? 0 : Math.max(240, Math.min(5000, basis * (button.dataset.zoom === 'in' ? 1.25 : .8))));
  }));
  dialog.addEventListener('close', () => {
    players.forEach(player => player.pause());
    if (!current) return;
    current.style.removeProperty('--figure-width');
    const viewport = current.querySelector('.figure-viewport');
    ['tabindex', 'role', 'aria-label'].forEach(attribute => viewport.removeAttribute(attribute));
    placeholder.replaceWith(current);
    document.body.style.overflow = previousOverflow;
    trigger.focus({ preventScroll: true });
    current = null;
  });
})();
