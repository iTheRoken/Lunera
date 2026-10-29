/* A fixed Halloween scene. Only the small ornament buttons capture input. */
(() => {
  'use strict';
  const scene = document.getElementById('halloweenDecorations');
  if (!scene) return;
  const icons = {
    moon: '<circle cx="32" cy="32" r="21" fill="currentColor"/><circle cx="24" cy="25" r="4" fill="#bfb3ca" opacity=".4"/><circle cx="39" cy="39" r="6" fill="#bfb3ca" opacity=".3"/><circle cx="39" cy="21" r="2.5" fill="#bfb3ca" opacity=".4"/>',
    pumpkin: '<path d="M32 19c-8-7-24 1-24 17 0 14 11 21 24 18 13 3 24-4 24-18 0-16-16-24-24-17Z" fill="url(#hw-pumpkin)"/><path d="M31 19c-1-7 2-10 7-12" fill="none" stroke="#8c9a74" stroke-width="5" stroke-linecap="round"/><path d="M26 20c-9 10-9 24-3 33m15-33c9 10 9 24 3 33" fill="none" stroke="#853f28" opacity=".45" stroke-width="2"/><g class="hw-pumpkin-face" fill="#ffe9b0"><path d="m18 33 10-5-2 9Zm28 0-10-5 2 9ZM21 42l6 3 5-2 5 2 6-3c-3 12-19 12-22 0Z"/></g>',
    ghost: '<path d="M14 49V29a18 18 0 0 1 36 0v20l-6-4-6 5-6-5-6 5-6-5-6 4Z" fill="url(#hw-ghost)"/><g fill="#40334f"><ellipse cx="26" cy="29" rx="2.5" ry="4"/><ellipse cx="39" cy="29" rx="2.5" ry="4"/><path d="M29 39q4 5 8 0" fill="none" stroke="#40334f" stroke-width="2" stroke-linecap="round"/></g><g fill="#ecb1b5" opacity=".6"><ellipse cx="21" cy="36" rx="4" ry="2"/><ellipse cx="43" cy="36" rx="4" ry="2"/></g>',
    bat: '<path d="M30 24 27 17l-3 7C16 13 8 16 3 10c-1 15 6 24 14 26l2-7 6 7 7 9 7-9 6-7 2 7c8-2 15-11 14-26-5 6-13 3-21 14l-3-7-3 7Z" fill="currentColor"/><g fill="#f6c28e"><circle cx="29" cy="28" r="1.5"/><circle cx="35" cy="28" r="1.5"/></g>'
  };
  icons.potion = '<path d="M25 8h14v5h-2v13l12 17c6 10-1 14-17 14S9 53 15 43l12-17V13h-2Z" fill="#bcabd0" fill-opacity=".12" stroke="#ae99ba" stroke-width="1.5"/><path d="M20 39q7-4 13 0t12 0l3 6c3 7-3 9-16 9s-19-2-16-9Z" fill="#b49ac7" fill-opacity=".6"/><circle cx="29" cy="43" r="2" fill="#eee2f5"/><circle cx="37" cy="49" r="1.5" fill="#eee2f5"/><path d="M27 5h10v7H27Z" fill="#ad8262"/><path d="m46 17 2-4 2 4 4 2-4 2-2 4-2-4-4-2Z" fill="#e7c793"/>';
  icons.candles = '<g fill="#d3b99c"><rect x="12" y="29" width="10" height="26" rx="3"/><rect x="28" y="19" width="11" height="36" rx="3"/><rect x="45" y="35" width="8" height="20" rx="3"/></g><g class="hw-candle-flames" fill="#ffe4a6"><path d="M17 16q-8 10 0 11 7-2 0-11ZM33 5q-8 10 0 12 8-2 0-12ZM49 23q-6 8 0 10 6-2 0-10Z"/></g><path d="M8 57h49" stroke="#87718c" stroke-width="2" stroke-linecap="round"/>';
  icons.books = '<g stroke="#dec3b1" stroke-opacity=".3"><rect x="8" y="20" width="12" height="34" rx="2" fill="#8a655c"/><rect x="21" y="14" width="13" height="40" rx="2" fill="#786080"/><path d="m36 22 11-3 9 32-11 3Z" fill="#9a815e"/></g><path d="M12 27h4m-4 20h4m9-25h5m-5 24h5m12-18 5-1" stroke="#e4c7a6" stroke-width="2" stroke-linecap="round"/><path d="M6 56h52" stroke="#79637e" stroke-width="2"/>';
  let svgSequence = 0;
  const svg = (name) => {
    const prefix = `hw-art-${++svgSequence}`;
    return `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${prefix}-pumpkin" x2="1" y2="1"><stop stop-color="#efa968"/><stop offset=".5" stop-color="#cd7545"/><stop offset="1" stop-color="#8f452f"/></linearGradient><linearGradient id="${prefix}-ghost" x2=".4" y2="1"><stop stop-color="#f4efff"/><stop offset="1" stop-color="#b4a1d0"/></linearGradient></defs>${icons[name].replaceAll('url(#hw-', `url(#${prefix}-`)}</svg>`;
  };
  scene.classList.add('hw-scene');
  scene.setAttribute('role', 'group');
  scene.setAttribute('aria-label', 'Decoraciones de Halloween');
  scene.innerHTML = `
    <div class="hw-sky" aria-hidden="true"></div>
    <div class="hw-constellation" aria-hidden="true">${Array.from({ length: 22 }, (_, i) => `<i style="--x:${8 + ((i * 37) % 89)}%;--y:${4 + ((i * 23) % 86)}%;--delay:${-(i % 7)}s"></i>`).join('')}</div>
    <div class="hw-landscape" aria-hidden="true"><svg viewBox="0 0 1400 180" preserveAspectRatio="none"><path d="M0 150Q140 80 320 144T660 138T1000 143T1400 112V180H0Z" fill="#302239"/><path d="M0 170Q180 120 420 160T850 157T1400 144V180H0Z" fill="#211c2b"/><g stroke="#564358" stroke-width="3" fill="none"><path d="M1320 170V30m0 54-35-28m35 52 34-32m-34-12 18-30m-18 21-21-25M90 170V80m0 47-26-21m26 39 22-24"/></g><g fill="#65526c" opacity=".7"><path d="M1160 168v-28a10 10 0 0 1 20 0v28Zm29 2v-17a7 7 0 0 1 14 0v17Z"/></g></svg></div>
    <div class="hw-web hw-web-left" aria-hidden="true"></div>
    <div class="hw-web hw-web-right" aria-hidden="true"></div>
    <button type="button" class="hw-charm hw-moon" data-charm="moon" aria-label="Iluminar la luna" aria-pressed="false" title="Un poquito de luz lunar">${svg('moon')}</button>
    <span class="hw-perched-bat" aria-hidden="true">${svg('bat')}</span>
    <button type="button" class="hw-charm hw-pumpkin" data-charm="pumpkin" aria-label="Encender la calabaza" aria-pressed="false" title="Enciende su luz">${svg('pumpkin')}</button>
    <button type="button" class="hw-charm hw-ghost" data-charm="ghost" aria-label="Saludar al fantasma" title="Un pequeño boo">${svg('ghost')}<span class="hw-boo" aria-hidden="true">Boo ♡</span></button>`;

  const animations = new Map();
  const greetingTimers = new Map();
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || document.body.classList.contains('settings-reduce-motion')
    || document.body.dataset.settingsAnimation === 'reduced';

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-charm]');
    if (!button || scene.inert || !button.closest('.hw-scene, .hw-section-scene')) return;
    const kind = button.dataset.charm;
    if (kind !== 'ghost') {
      const lit = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(lit));
      button.setAttribute('aria-label', kind === 'moon'
        ? (lit ? 'Atenuar la luna' : 'Iluminar la luna')
        : (lit ? 'Apagar la calabaza' : 'Encender la calabaza'));
    }
    animations.get(button)?.cancel();
    if (!reducedMotion() && typeof button.animate === 'function') {
      const animation = button.querySelector('svg').animate([
        { transform: 'translateY(0) rotate(0deg) scale(1)' },
        { transform: 'translateY(-5px) rotate(-7deg) scale(1.06)', offset: .3 },
        { transform: 'translateY(-2px) rotate(4deg) scale(1.02)', offset: .65 },
        { transform: 'translateY(0) rotate(0deg) scale(1)' }
      ], { duration: 1050, easing: 'cubic-bezier(.22,1,.36,1)' });
      animations.set(button, animation);
      animation.onfinish = () => animations.delete(button);
    }
    if (kind === 'ghost') {
      window.clearTimeout(greetingTimers.get(button));
      button.classList.remove('is-greeting');
      void button.offsetWidth;
      button.classList.add('is-greeting');
      greetingTimers.set(button, window.setTimeout(() => {
        button.classList.remove('is-greeting');
        greetingTimers.delete(button);
      }, 2400));
    }
  });
  document.addEventListener('animationend', event => {
    if (event.animationName === 'hw-greeting') event.target.closest('.hw-ghost')?.classList.remove('is-greeting');
  });
  // These ornaments belong to the document, not the fixed viewport layer.
  // Their containing section naturally carries them away when scrolling.
  const sectionScenes = [
    { id: 'home', anchor: '.home-stage', art: 'candles', charm: 'ghost' },
    { id: 'search', anchor: '.search-hero', art: 'potion', charm: 'pumpkin' },
    { id: 'library', anchor: '.library-command-deck', art: 'books', charm: 'ghost' },
    { id: 'mymusic', anchor: '.my-music-hero', art: 'candles', charm: 'pumpkin' },
    { id: 'settings', anchor: '.settings-hero, .settings-header', art: 'potion', charm: 'ghost' }
  ];
  const mountSectionScenes = () => {
    if (document.body.dataset.interfaceMode !== 'halloween') return;
    sectionScenes.forEach(({ id, anchor, art, charm }) => {
      const page = document.getElementById(id);
      const host = page?.querySelector(anchor);
      if (!host || page.querySelector('.hw-section-scene')) return;
      const ornament = document.createElement('div');
      ornament.className = `hw-section-scene hw-section-${id}`;
      ornament.setAttribute('role', 'group');
      ornament.setAttribute('aria-label', 'Rincón de Halloween');
      ornament.innerHTML = `<span class="hw-shelf-art" aria-hidden="true">${svg(art)}</span><span class="hw-section-thread" aria-hidden="true"></span><span class="hw-section-sparkles" aria-hidden="true">✦ · ✧</span><button type="button" class="hw-charm hw-section-charm" data-charm="${charm}" aria-label="${charm === 'ghost' ? 'Saludar al fantasma' : 'Encender la calabaza'}" ${charm === 'pumpkin' ? 'aria-pressed="false"' : ''}>${svg(charm)}${charm === 'ghost' ? '<span class="hw-boo" aria-hidden="true">Boo ♡</span>' : ''}</button>`;
      if (charm === 'ghost') ornament.querySelector('button').classList.add('hw-ghost');
      host.after(ornament);
    });
  };
  let mountFrame = null;
  const contentObserver = new MutationObserver(records => {
    if (mountFrame !== null || !records.some(record => record.addedNodes.length)) return;
    mountFrame = window.requestAnimationFrame(() => {
      mountFrame = null;
      mountSectionScenes();
    });
  });
  const syncMode = () => {
    const enabled = document.body.dataset.interfaceMode === 'halloween';
    scene.inert = !enabled;
    scene.setAttribute('aria-hidden', String(!enabled));
    document.querySelectorAll('.hw-section-scene').forEach(ornament => {
      ornament.inert = !enabled;
      ornament.setAttribute('aria-hidden', String(!enabled));
    });
    contentObserver.disconnect();
    if (enabled) {
      mountSectionScenes();
      const content = document.querySelector('.main-content');
      if (content) contentObserver.observe(content, { childList: true, subtree: true });
    }
    if (!enabled) {
      if (mountFrame !== null) window.cancelAnimationFrame(mountFrame);
      mountFrame = null;
      greetingTimers.forEach(timer => window.clearTimeout(timer));
      greetingTimers.clear();
      animations.forEach(animation => animation.cancel());
      animations.clear();
      document.querySelectorAll('.hw-ghost.is-greeting').forEach(ghost => ghost.classList.remove('is-greeting'));
    }
  };
  new MutationObserver(syncMode).observe(document.body, { attributes: true, attributeFilter: ['data-interface-mode'] });
  syncMode();
})();
