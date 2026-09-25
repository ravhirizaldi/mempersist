/** Public-page enhancements only. OAuth deliberately never includes this script. */
export const SITE_SCRIPT = `
(() => {
  const copy = document.body.dataset;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set();
  function enter(element, delay = 0) {
    if (motion.matches || !element.animate) return;
    const animation = element.animate(
      [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 600, delay, easing: 'cubic-bezier(.16,1,.3,1)' }
    );
    animations.add(animation);
    animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
  }
  motion.addEventListener('change', () => {
    if (motion.matches) animations.forEach(animation => animation.cancel());
  });

  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
   const nav = document.querySelector('.site-nav');
  if (toggle && links) {
     const scrim = document.createElement('div');
     scrim.className = 'nav-scrim';
     scrim.hidden = true;
     scrim.setAttribute('aria-hidden', 'true');
     nav.appendChild(scrim);

     const focusables = 'a, button';

    function closeMenu() {
      links.classList.remove('open');
       scrim.classList.remove('open');
       toggle.setAttribute('aria-expanded', 'false');
       document.body.style.overflow = '';
       window.setTimeout(() => { if (!links.classList.contains('open')) scrim.hidden = true; }, 400);
    }

     function openMenu() {
       scrim.hidden = false;
       links.classList.add('open');
       document.body.style.overflow = 'hidden';
       toggle.setAttribute('aria-expanded', 'true');
       window.requestAnimationFrame(() => {
         scrim.classList.add('open');
         const first = links.querySelector(focusables);
         if (first) first.focus();
       });
     }

    toggle.hidden = false;
    links.classList.add('enhanced');

    toggle.addEventListener('click', () => {
       if (links.classList.contains('open')) closeMenu();
       else openMenu();
    });

     scrim.addEventListener('click', closeMenu);

    links.addEventListener('click', event => {
      if (event.target.closest('a')) closeMenu();
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && links.classList.contains('open')) {
        closeMenu();
        toggle.focus();
      }
    });

     links.addEventListener('keydown', event => {
       if (event.key !== 'Tab') return;
       const items = [...links.querySelectorAll(focusables)];
       if (items.length === 0) return;
       const active = document.activeElement;
       if (event.shiftKey) {
         if (active === items[0] || active === toggle) {
           items[items.length - 1].focus();
           event.preventDefault();
         }
       } else {
         if (active === items[items.length - 1]) {
           toggle.focus();
           event.preventDefault();
         }
       }
     });

    window.matchMedia('(min-width: 801px)').addEventListener('change', closeMenu);
  }

  const feedback = document.querySelector('#copy-feedback');
  document.querySelectorAll('[data-copy]').forEach(button => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    button.hidden = false;
    button.addEventListener('click', async () => {
      const original = button.textContent;
      button.disabled = true;
      feedback.textContent = '';
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        button.textContent = copy.copied;
        feedback.textContent = copy.copySuccess;
      } catch {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        if (selection) { selection.removeAllRanges(); selection.addRange(range); }
        feedback.textContent = copy.copyFailed;
      } finally {
        button.disabled = false;
        window.setTimeout(() => { button.textContent = original; }, 2200);
      }
    });
  });

  const demo = document.querySelector('[data-demo]');
  if (demo) {
    const steps = [...demo.querySelectorAll('[data-step]')];
    const panels = [...demo.querySelectorAll('[data-example]')];
    const select = index => {
      steps.forEach((step, i) => step.setAttribute('aria-pressed', String(i === index)));
      panels.forEach((panel, i) => { panel.hidden = i !== index; });
      enter(panels[index]);
    };
    steps.forEach((step, index) => step.addEventListener('click', () => select(index)));
    demo.querySelector('.demo-controls').hidden = false;
    select(0);
  }

  const filter = document.querySelector('#decision-search');
  if (filter) {
    const rows = [...document.querySelectorAll('[data-decision]')];
    const count = document.querySelector('#decision-count');
    const empty = document.querySelector('#decision-empty');
    const clear = document.querySelector('#clear-search');
    function update() {
      const query = filter.value.trim().toLowerCase();
      let visible = 0;
      rows.forEach(row => {
        row.hidden = !row.textContent.toLowerCase().includes(query);
        if (!row.hidden) visible++;
      });
      count.textContent = copy.decisionCount.replace('{visible}', visible).replace('{total}', rows.length);
      empty.hidden = visible !== 0;
      clear.disabled = filter.value.length === 0;
    }
    document.querySelector('.filter-bar').hidden = false;
    filter.addEventListener('input', update);
    filter.addEventListener('keydown', event => {
      if (event.key === 'Escape') { filter.value = ''; update(); }
    });
    clear.addEventListener('click', () => { filter.value = ''; update(); filter.focus(); });
    update();
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach((entry, index) => {
        if (!entry.isIntersecting) return;
        enter(entry.target, Math.min(index * 60, 180));
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.05 });
    document.querySelectorAll('.hero, .document > section, .auth-panel, .archive-preview').forEach(el => observer.observe(el));

    const toc = document.querySelector('.toc');
    if (toc) {
      const tocLinks = [...toc.querySelectorAll('a')];
      const sections = tocLinks.map(link => document.getElementById(link.hash.slice(1)));
      const update = () => {
        let active = sections[0];
        sections.forEach(section => { if (section.getBoundingClientRect().top <= window.innerHeight * .4) active = section; });
        tocLinks.forEach(link => {
          if (link.hash === '#' + active.id) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        });
      };
      const tracker = new IntersectionObserver(update, { rootMargin: '-10% 0px -55% 0px' });
      sections.forEach(section => tracker.observe(section));
    }
  }
})();
`;

export const CRITICAL_SITE_CSS = `
.site-nav{position:sticky;top:0;z-index:10;background:var(--canvas);border-bottom:1px solid var(--line)}
.nav{max-width:1224px;margin:auto;padding:20px 32px;display:flex;align-items:center;gap:28px}
.nav-links{display:flex;gap:25px;margin-left:auto;align-items:center}
.nav-links a{text-decoration:none;color:var(--muted);font-size:13px}
.language-switch{display:flex;align-items:center;gap:6px;font:10px var(--mono);color:var(--muted);white-space:nowrap}
.language-switch a{text-decoration:none;padding:4px 2px}
.nav-cta{font-size:12px;min-height:36px;padding:7px 14px}
.nav-toggle{display:none;border:1px solid var(--line);background:var(--surface);border-radius:4px;width:44px;height:44px;padding:0;color:var(--ink);position:relative;z-index:13}
.wrap{max-width:1224px;margin:auto;padding:72px 32px 32px}
.page-meta{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:36px;font:10px var(--mono);color:var(--muted);letter-spacing:.05em}
.hero{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:80px;align-items:center;padding:24px 0 80px}
.hero h1{font-size:clamp(44px,5.2vw,70px);line-height:1.04;margin:0;letter-spacing:-.055em}
.hero h1 span{display:block;color:var(--accent);font-family:Georgia,serif;font-weight:400;font-style:italic;letter-spacing:-.055em}
.lead{font-size:18px;line-height:1.7;max-width:58ch;margin:24px 0 0}
.hero .lead{font-size:17px;max-width:42ch}
.hero-actions{display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-top:30px;font-size:14px}
.text-link{text-decoration:none;border-bottom:1px solid var(--line);padding:7px 0}
.hero-caption{font:10px/1.8 var(--mono);color:var(--muted);margin-top:22px}
.archive-preview{position:relative;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:24px}
.preview-top{display:flex;justify-content:space-between;gap:14px;font:10px var(--mono);color:var(--muted);padding-bottom:20px;border-bottom:1px solid var(--line)}
.endpoint{display:flex;align-items:center;gap:16px;border:1px solid var(--line);border-radius:6px;padding:17px 20px;background:var(--surface)}
.endpoint-label{font:10px var(--mono);color:var(--muted);white-space:nowrap}
.endpoint code{flex:1;color:var(--accent);font-size:12px}
@media(max-width:800px){.wrap{padding:40px 22px 24px}.nav{padding:16px 22px}.nav-toggle:not([hidden]){display:grid;order:5;margin-left:auto}.language-switch{order:2;margin-left:auto}.nav-sign-in{order:3}.hero{grid-template-columns:1fr;gap:40px;padding:0 0 48px}.hero h1{font-size:clamp(42px,12vw,64px)}.endpoint{align-items:flex-start;flex-wrap:wrap}.endpoint code{width:100%;order:3}.archive-preview{padding:18px}}
`;

export const SITE_CSS = `
.site-nav{position:sticky;top:0;z-index:10;background:var(--canvas);border-bottom:1px solid var(--line)}
.nav{max-width:1224px;margin:auto;padding:20px 32px;display:flex;align-items:center;gap:28px}
.nav-links{display:flex;gap:25px;margin-left:auto;align-items:center}
.nav-links a{text-decoration:none;color:var(--muted);font-size:13px;transition:color .2s}
.nav-links a:hover,.nav-links a[aria-current]{color:var(--ink)}
.nav-links a[aria-current]::after{content:"";display:block;height:2px;background:var(--accent);transform:translateY(7px)}
.language-switch{display:flex;align-items:center;gap:6px;font:10px var(--mono);color:var(--muted);white-space:nowrap}
.language-switch a{text-decoration:none;padding:4px 2px}
.language-switch a[aria-current]{color:var(--accent);font-weight:600}
.nav-cta{font-size:12px;min-height:36px;padding:7px 14px}
.nav-toggle{display:none;border:1px solid var(--line);background:var(--surface);border-radius:4px;width:44px;height:44px;padding:0;color:var(--ink);position:relative;z-index:13;cursor:pointer;place-items:center;transition:border-color .2s}.hamburger{display:block;width:18px;height:12px;position:relative;background:linear-gradient(var(--ink),var(--ink)) 0 5px/18px 2px no-repeat;transition:background .2s}.hamburger::before,.hamburger::after{content:"";position:absolute;left:0;width:18px;height:2px;background:var(--ink);transition:transform .25s var(--ease),top .25s var(--ease)}.hamburger::before{top:0}.hamburger::after{top:10px}.nav-toggle[aria-expanded="true"] .hamburger{background:none}.nav-toggle[aria-expanded="true"] .hamburger::before{top:5px;transform:rotate(45deg)}.nav-toggle[aria-expanded="true"] .hamburger::after{top:5px;transform:rotate(-45deg)}
.nav-scrim{position:fixed;inset:0;z-index:10;background:rgba(40,42,37,.4);backdrop-filter:blur(3px);opacity:0;transition:opacity .4s var(--ease);pointer-events:none}
.nav-scrim.open{opacity:1;pointer-events:all}
.wrap{max-width:1224px;margin:auto;padding:72px 32px 32px}
.page-meta{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:36px;font:10px var(--mono);color:var(--muted);letter-spacing:.05em}
.page-meta a{text-decoration:none}
.hero{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:80px;align-items:center;padding:24px 0 80px}
.hero h1{font-size:clamp(44px,5.2vw,70px);line-height:1.04;margin:0;letter-spacing:-.055em}
.hero h1 span{display:block;color:var(--accent);font-family:Georgia,serif;font-weight:400;font-style:italic;letter-spacing:-.055em}
.lead{font-size:18px;line-height:1.7;max-width:58ch;margin:24px 0 0;text-wrap:pretty}
.hero .lead{font-size:17px;max-width:42ch}
.hero-actions{display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-top:30px;font-size:14px}
.text-link{text-decoration:none;border-bottom:1px solid var(--line);padding:7px 0}
.hero-caption{font:10px/1.8 var(--mono);color:var(--muted);margin-top:22px}
.archive-preview{position:relative;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:24px}
.preview-top{display:flex;justify-content:space-between;gap:14px;font:10px var(--mono);color:var(--muted);padding-bottom:20px;border-bottom:1px solid var(--line)}
.preview-top span:last-child{color:var(--accent)}
.demo-controls{display:flex;gap:4px;padding:18px 0 8px}
.demo-controls button{flex:1;border:0;border-radius:4px;background:transparent;color:var(--muted);padding:10px 6px;font-size:12px;transition:background .2s,color .2s}
.demo-controls button[aria-pressed=true]{background:var(--tint);color:var(--accent)}
.demo-controls button:hover{background:var(--canvas)}
.demo-panel{min-height:236px;padding:24px 0 4px}
.demo-panel+.demo-panel{border-top:1px solid var(--line)}
.demo-panel .eyebrow{font-size:9px;letter-spacing:.06em;margin-bottom:18px}
.demo-panel h2{font-size:27px;max-width:19ch;margin:0 0 16px}
.demo-panel p{font-size:13px;line-height:1.8;margin:0;max-width:40ch}
.preview-bottom{display:flex;justify-content:space-between;gap:16px;padding-top:18px;border-top:1px solid var(--line);font:9px/1.6 var(--mono);color:var(--muted)}
.endpoint{display:flex;align-items:center;gap:16px;border:1px solid var(--line);border-radius:6px;padding:17px 20px;background:var(--surface)}
.endpoint-label{font:10px var(--mono);color:var(--muted);white-space:nowrap}
.endpoint code{flex:1;color:var(--accent);font-size:12px}
.copy-button{flex-shrink:0;padding:8px 12px;min-height:36px;border:1px solid var(--line);border-radius:4px;color:var(--ink);background:transparent;font-size:12px;transition:background .2s,transform .2s}
.copy-button:hover{background:var(--tint)}
.copy-button:active{transform:scale(.98)}
.copy-feedback{font-size:12px;min-height:24px;margin:8px 0;color:var(--accent)}
.auth-panel{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:72px;align-items:center;margin:32px 0 80px;padding:40px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.auth-panel h2{font-size:30px;margin:0}
.auth-panel p:not(.eyebrow){font-size:14px;max-width:55ch}
.auth-panel .eyebrow{margin-bottom:12px}
.auth-steps{display:grid;gap:20px}
.auth-steps span{display:flex;align-items:center;gap:18px;font-size:14px}
.auth-steps b{font:11px var(--mono);color:var(--accent);background:var(--tint);padding:8px;border-radius:4px}
.reading-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:64px;align-items:start}
.toc{position:sticky;top:116px;font-size:12px}
.toc p{font:10px var(--mono);margin:0 0 20px;color:var(--muted)}
.toc a{display:block;color:var(--muted);text-decoration:none;border-left:1px solid var(--line);padding:9px 0 9px 16px;line-height:1.4}
.toc a:hover,.toc a[aria-current]{color:var(--accent);border-left:2px solid var(--accent);padding-left:15px}
.document{min-width:0;max-width:816px}
.document>h1{font-size:clamp(34px,4.5vw,54px);margin:0;max-width:22ch}
.document>section{padding-top:44px;margin-top:44px;border-top:1px solid var(--line);scroll-margin-top:100px}
.document>section:first-child{padding-top:0;margin-top:0;border-top:0}
.document h2{font-size:28px;margin:0 0 22px}
.document h3{font-size:18px;margin:28px 0 12px}
.document p,.document li{font-size:15px;line-height:1.85}
.document p{max-width:70ch}
.document ul,.document ol{padding-left:22px;color:var(--muted)}
.document li{padding-left:5px;margin:13px 0}
.document strong{font-weight:500;color:var(--ink)}
.document p code,.document li code{background:var(--tint);color:var(--accent);padding:2px 4px;border-radius:3px}
.code-block{margin:16px 0 0;border:1px solid var(--line);border-radius:6px;background:var(--surface);overflow:hidden}
.code-heading{display:flex;justify-content:space-between;align-items:center;padding:9px 16px;border-bottom:1px solid var(--line);font:10px var(--mono);color:var(--muted)}
.code{margin:0;padding:20px;color:var(--ink);font:12px/1.8 var(--mono);overflow-x:auto;white-space:pre}
.note{margin:24px 0 0;padding:18px 22px;border-left:2px solid var(--accent);background:var(--tint);color:var(--accent);font-size:13px;line-height:1.8}
.table-scroll{overflow-x:auto;margin:20px 0;border:1px solid var(--line);border-radius:6px;background:var(--surface)}
table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}
th,td{padding:16px 20px;border-bottom:1px solid var(--line);vertical-align:top}
th{font:10px/1.5 var(--mono);color:var(--muted);background:var(--canvas);letter-spacing:.04em}
td{color:var(--muted);line-height:1.7}
td:first-child{color:var(--ink)}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--canvas)}
.diagram{position:relative;margin:40px 0;padding:12px;border:1px solid var(--line);border-radius:12px;overflow-x:auto;background:var(--surface);box-shadow:0 14px 34px rgba(66,99,74,.06)}
.diagram svg{display:block;width:100%;min-width:680px;height:auto;margin:auto}
.diagram text{font-family:var(--mono);fill:var(--ink)}
.diagram path{fill:none;stroke:#a8b3a2;stroke-width:1.5}
.diagram .diagram-bg{fill:var(--surface);stroke:var(--line);stroke-width:1}
.diagram .diagram-grid{fill:url(#diagram-grid);stroke:none;opacity:.42}
.diagram .diagram-header text{font-size:9px;letter-spacing:.16em;fill:var(--muted)}
.diagram .diagram-band text{font-size:9px;letter-spacing:.12em;fill:var(--accent)}
.diagram .diagram-band path{stroke:var(--line);stroke-width:1}
.diagram .diagram-node rect{fill:var(--canvas);stroke:var(--line);stroke-width:1.2}
.diagram .diagram-node--edge rect{fill:var(--ink);stroke:var(--ink)}
.diagram .diagram-node--edge text{fill:var(--surface)}
.diagram .diagram-node--edge .diagram-node-meta{fill:#c8d1c5}
.diagram .diagram-node--auth rect{fill:var(--tint);stroke:#cbd8c5}
.diagram .diagram-node--durable rect{fill:#f1f4ed;stroke:#cbd8c5}
.diagram .diagram-node--queue rect{fill:#f5f0e7;stroke:#dfd2bb}
.diagram .diagram-node--derived rect{fill:var(--surface);stroke:var(--line)}
.diagram .diagram-node circle{fill:var(--accent)}
.diagram .diagram-node--edge circle{fill:#c4d7b9}
.diagram .diagram-node--auth circle{fill:#9b7e50}
.diagram .diagram-node--queue circle{fill:#9b7e50}
.diagram .diagram-node-title{font:500 16px/1 var(--mono);letter-spacing:-.04em}
.diagram .diagram-node-meta{font-size:10px;fill:var(--muted)}
.diagram .diagram-node-kicker{font-size:8px;letter-spacing:.14em;fill:var(--accent)}
.diagram #diagram-arrow path{fill:#80957b;stroke:none}
.diagram #search-diagram-arrow path{fill:#80957b;stroke:none}
.diagram .diagram-flow{stroke:#80957b;stroke-width:1.6}
.diagram .diagram-flow--auth{stroke:#9b7e50;stroke-dasharray:3 4}
.diagram .diagram-flow--derived{stroke:#9a9b88;stroke-dasharray:6 5}
.diagram .diagram-flow marker-end{fill:#80957b}
.diagram .diagram-footer text{font-size:9px;fill:var(--muted)}
.diagram .diagram-footer circle{fill:var(--accent)}
.diagram .diagram-footer path{stroke:var(--line);stroke-width:1}
.filter-bar{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end;margin-top:40px}
.filter-bar label{font-size:12px;display:block;margin-bottom:8px}
.filter-bar input{width:100%;min-height:46px;border:1px solid var(--line);border-radius:5px;background:var(--surface);padding:10px 14px;color:var(--ink)}
.filter-bar input::placeholder{color:var(--muted)}
.filter-meta{display:flex;align-items:center;justify-content:space-between;font:10px var(--mono);color:var(--muted);margin:18px 0}
.accepted{display:inline-block;color:var(--accent);background:var(--tint);padding:3px 8px;border-radius:4px;font:10px/1.6 var(--mono)}
.empty-state{padding:32px;text-align:center;background:var(--surface);border:1px dashed var(--line);border-radius:6px}
.empty-state h3{font-size:22px;margin:0 0 12px}
.empty-state p{margin:0;font-size:14px}
footer{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-top:88px;padding:26px 0 0;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}
.footer-links{display:flex;gap:20px}
footer a{text-decoration:none}
@media(min-width:1100px){.home .reading-layout{grid-template-columns:240px minmax(0,1fr);gap:92px}}
@media(max-width:1000px){.hero{gap:32px}.reading-layout{grid-template-columns:150px minmax(0,1fr);gap:32px}.nav-links{gap:16px}.nav{gap:18px}.nav-cta{display:none}}
@media(max-width:800px){.wrap{padding:40px 22px 24px}.nav{padding:16px 22px}.nav-toggle:not([hidden]){display:grid;order:5;margin-left:auto}.language-switch{order:2;margin-left:auto}.nav-sign-in{order:3}.nav-toggle[aria-expanded="true"]{position:fixed;top:16px;right:22px;z-index:13}.nav-links{width:100%;flex-wrap:wrap;margin:0;gap:12px 24px}.nav-links.enhanced{display:flex;position:fixed;top:0;right:0;bottom:0;width:min(320px,85vw);background:var(--surface);border-left:1px solid var(--line);padding:92px 32px 32px;flex-direction:column;align-items:stretch;gap:8px;z-index:11;transform:translateX(100%);transition:transform .4s var(--ease);box-shadow:-4px 0 24px rgba(40,42,37,.06)}.nav-links.enhanced.open{transform:none}.nav-links.enhanced a{font-size:16px;padding:12px 0;border-bottom:1px solid var(--canvas);color:var(--ink)}.nav-links.enhanced a[aria-current]::after{display:none}.nav-links.enhanced a[aria-current]{font-weight:600;color:var(--accent)}.hero{grid-template-columns:1fr;gap:40px;padding:10px 0 36px}.hero h1{max-width:12ch;font-size:clamp(44px,9vw,66px)}.hero .lead{max-width:46ch}.archive-preview{max-width:520px}.auth-panel{grid-template-columns:1fr;gap:24px;padding:32px 0;margin-bottom:48px}.reading-layout{grid-template-columns:1fr;gap:32px}.toc{position:static;border-bottom:1px solid var(--line);padding-bottom:20px;display:flex;flex-wrap:wrap;gap:8px 16px}.toc p{width:100%;margin-bottom:6px}.toc a{border:0;padding:4px 0}.toc a:hover,.toc a[aria-current]{border:0;padding-left:0;text-decoration:underline}.endpoint{flex-wrap:wrap;padding:16px}.endpoint-label{width:100%}.endpoint code{min-width:0;font-size:11px}.document>h1{max-width:24ch}.document>section{margin-top:32px;padding-top:32px}.document h2{font-size:25px}.page-meta{margin-bottom:28px}.diagram{padding:12px}.table-scroll td,.table-scroll th{padding:12px}.filter-bar{margin-top:28px}footer{margin-top:56px}}
`;
