// Portfolio terminal: local commands, typing, history, and motion controls.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const output = $('output'), input = $('command-input');
  if (!output || !input) return;
  document.body.classList.add('terminal-enhanced');
  const themeToggle = $('theme-toggle');
  function updateThemeToggle() {
    const dark = document.documentElement.dataset.portfolioTheme !== 'light';
    $('theme-icon').textContent = dark ? '☀' : '☾';
    $('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
    themeToggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.portfolioTheme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.portfolioTheme = theme;
    updateThemeToggle();
    try { localStorage.setItem('pf-theme', theme); } catch {}
  });
  updateThemeToggle();
  const commands = ['about','experience','projects','notes','education','hobbies','contact','help','clear'];
  const aliases = {whoami:'about',home:'about',work:'experience',ls:'help',pwd:'about',email:'contact',vault:'notes',skills:'about'};
  const displayed = {about:'whoami',experience:'cat experience.md',projects:'ls ./projects',notes:'open ./vault',education:'cat education.md',hobbies:'cat life-outside-code.md',contact:'cat contact.txt',help:'help',clear:'clear'};
  const quips = {about:"Fine. I'll show you the portfolio.",experience:'Nine years. A LOT of keystrokes.',projects:'Respect my architecture.',notes:'I even read the documentation.',education:'Yes, there was studying involved.',hobbies:'Even I take a keyboard break.',contact:"I'll type. He'll reply.",help:'Okay, here are the cheat codes.',clear:'Clean terminal. Fresh start.'};
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let paused = reduced.matches, instant = reduced.matches, pendingFinish = null, frame = 0, sequence = 0;
  try {
    paused ||= localStorage.getItem('pf-motion') === 'paused';
    instant ||= localStorage.getItem('pf-instant') === 'true';
  } catch { /* Preferences remain usable when storage is unavailable. */ }
  let history = [], historyIndex = 0, draft = '', activeCommand = 'about';
  let inputTimer = 0;

  function state(typing) {
    const characterTyping = (typing || !!inputTimer) && !paused;
    document.body.classList.toggle('is-typing', characterTyping);
    document.body.classList.toggle('is-output-typing', typing && !paused);
    $('terminal-state').textContent = typing ? 'typing…' : 'ready';
    $('scene-status').textContent = paused ? 'CARTMAN IS TAKING A BREAK' : characterTyping ? 'CARTMAN IS TYPING…' : 'CARTMAN IS AT THE KEYBOARD';
    $('skip-typing').hidden = !typing;
    output.setAttribute('aria-busy', String(typing));
  }
  function stopInputTyping() {
    clearTimeout(inputTimer);
    inputTimer = 0;
    state(!!pendingFinish);
  }
  function inputTyping() {
    if (paused) return;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(stopInputTyping, 800);
    state(!!pendingFinish);
  }
  function finishTyping() { if (pendingFinish) pendingFinish(); }
  function render(command, raw, animate = true) {
    stopInputTyping();
    finishTyping();
    sequence++;
    const ownSequence = sequence;
    activeCommand = command;
    $('shown-command').textContent = raw || displayed[command] || command;
    $('cartman-line').textContent = quips[command] || 'That command is above my pay grade.';
    document.querySelectorAll('.terminal-nav button').forEach(button => {
      const selected = button.dataset.command === command;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    output.replaceChildren();
    const template = $('content-' + command);
    if (template) output.append(template.content.cloneNode(true));
    else if (command === 'clear') {
      const p = document.createElement('p'); p.className = 'end-note';
      p.textContent = 'Terminal cleared. Type help to see the available commands.'; output.append(p);
    } else {
      const h = document.createElement('h2'); h.textContent = 'Command not found.';
      const p = document.createElement('p'); p.textContent = 'Try about, experience, projects, notes, education, hobbies, contact, or help.';
      output.append(h,p);
    }
    $('viewport').scrollTop = 0;
    const walker = document.createTreeWalker(output, NodeFilter.SHOW_TEXT);
    const nodes = []; let node;
    while ((node = walker.nextNode())) if (node.textContent.trim()) nodes.push({node,text:node.textContent});
    const done = () => {
      cancelAnimationFrame(frame);
      nodes.forEach(item => { item.node.textContent = item.text; });
      pendingFinish = null; state(false);
      $('announcement').textContent = template ? command + ' section loaded.' : command === 'clear' ? 'Terminal cleared.' : 'Command not found. Type help for available commands.';
    };
    if (instant || paused || !animate) { done(); return; }
    const total = nodes.reduce((sum,item) => sum + item.text.length,0);
    nodes.forEach(item => { item.node.textContent = ''; });
    pendingFinish = done; state(true);
    const start = performance.now(), duration = Math.min(2400, Math.max(1000,total * 2.5));
    function tick(now) {
      if (sequence !== ownSequence) return;
      let remaining = Math.floor(total * Math.min(1,(now - start)/duration));
      nodes.forEach(item => { const count = Math.min(item.text.length, Math.max(0,remaining)); item.node.textContent = item.text.slice(0,count); remaining -= item.text.length; });
      if (now-start >= duration) done(); else frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }
  function normalize(value) {
    let cmd = value.trim().toLowerCase();
    if (cmd === 'ls ./projects') return 'projects';
    if (cmd === 'open ./vault') return 'notes';
    if (cmd.startsWith('cat ')) cmd = cmd.slice(4).replace(/\.(md|txt)$/,'');
    if (cmd === 'life-outside-code') return 'hobbies';
    return aliases[cmd] || cmd;
  }
  function run(value, remember = true) {
    const raw = value.trim(); if (!raw) return;
    if (remember) { history.push(raw); historyIndex = history.length; draft = ''; }
    input.value = '';
    const cmd = normalize(raw);
    if (commands.includes(cmd) && cmd !== 'clear') {
      const hash = '#' + cmd;
      if (location.hash !== hash) window.history.pushState(null,'',hash);
    }
    render(cmd, commands.includes(cmd) ? displayed[cmd] : raw);
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-command]');
    if (button) run(button.dataset.command);
  });
  $('command-form').addEventListener('submit', event => { event.preventDefault(); run(input.value); });
  // Input events cover physical keyboards, deletion, paste, and mobile keyboards.
  input.addEventListener('input', inputTyping);
  input.addEventListener('blur', stopInputTyping);
  input.addEventListener('keydown', event => {
    if (event.key === 'Tab' && input.value.trim()) {
      const possibilities = [...commands,...Object.keys(aliases)].filter(c => c.startsWith(input.value.trim().toLowerCase()));
      if (possibilities.length === 1) { event.preventDefault(); input.value = possibilities[0]; inputTyping(); }
    }
    if (event.key === 'ArrowUp' && history.length) {
      event.preventDefault(); if (historyIndex === history.length) draft = input.value;
      historyIndex = Math.max(0,historyIndex-1); input.value = history[historyIndex];
      inputTyping();
    }
    if (event.key === 'ArrowDown' && history.length) {
      event.preventDefault(); historyIndex = Math.min(history.length,historyIndex+1);
      input.value = historyIndex === history.length ? draft : history[historyIndex];
      inputTyping();
    }
    if (event.key === 'Escape') { input.value = ''; stopInputTyping(); finishTyping(); }
  });
  function updateMotion() {
    document.body.classList.toggle('paused', paused);
    document.body.style.setProperty('--amb', paused ? 'paused' : 'running');
    $('motion').setAttribute('aria-pressed',String(paused));
    $('motion-label').textContent = paused ? 'Resume motion' : 'Pause motion';
    $('motion-icon').textContent = paused ? '▷' : 'Ⅱ';
    if (paused) { stopInputTyping(); finishTyping(); }
    state(!!pendingFinish);
  }
  $('motion').addEventListener('click',() => {
    paused = !paused; updateMotion();
    try { localStorage.setItem('pf-motion', paused ? 'paused' : 'running'); } catch {}
  });
  $('read-mode').addEventListener('click',() => {
    instant = !instant; $('read-mode').setAttribute('aria-pressed',String(instant));
    $('read-mode').textContent = instant ? 'Typing text' : 'Instant text';
    if (instant) finishTyping();
    try { localStorage.setItem('pf-instant', String(instant)); } catch {}
  });
  $('skip-typing').addEventListener('click',finishTyping);
  reduced.addEventListener('change', event => { paused = event.matches; instant = event.matches; updateMotion(); $('read-mode').setAttribute('aria-pressed',String(instant)); $('read-mode').textContent = instant ? 'Typing text' : 'Instant text'; });
  document.addEventListener('visibilitychange',() => { if (document.hidden) { stopInputTyping(); finishTyping(); } });
  window.addEventListener('hashchange',() => { const cmd = normalize(location.hash.slice(1)) || 'about'; if (commands.includes(cmd) && cmd !== activeCommand) render(cmd); });
  updateMotion();
  $('read-mode').setAttribute('aria-pressed',String(instant));
  $('read-mode').textContent = instant ? 'Typing text' : 'Instant text';
  const initial = normalize(location.hash.slice(1));
  render(commands.includes(initial) ? initial : 'about');
})();
