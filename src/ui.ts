/** Shared, dependency-free visual foundation for public and script-free OAuth pages. */
export const BASE_CSS = `
:root{color-scheme:light;--canvas:#f7f6f2;--surface:#fffefa;--ink:#282a25;--muted:#66685f;--line:#dedfd6;--accent:#42634a;--tint:#e9eee4;--mono:"JetBrains Mono",ui-monospace,"SF Mono",monospace;--ease:cubic-bezier(.16,1,.3,1);font-family:Outfit,"Helvetica Neue","Segoe UI",sans-serif;font-synthesis:none;font-size:16px;background:var(--canvas);color:var(--ink)}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:100px}
body{margin:0;line-height:1.65;-webkit-font-smoothing:antialiased}
button,input{font:inherit}
button,a,input,summary{-webkit-tap-highlight-color:transparent}
button,a{touch-action:manipulation}
a{color:inherit;text-underline-offset:4px}
a:hover{color:var(--accent)}
button{cursor:pointer}
button:disabled{cursor:wait;opacity:.65}
:focus-visible{outline:2px solid var(--accent);outline-offset:5px}
[hidden]{display:none!important}
::selection{background:#dbe5d2;color:var(--ink)}
h1,h2,h3,p{overflow-wrap:break-word}
h1,h2,h3{font-weight:500;letter-spacing:-.035em;line-height:1.15;text-wrap:balance}
p{color:var(--muted)}
code,kbd{font-family:var(--mono);font-size:.85em;overflow-wrap:anywhere}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;flex-shrink:0}
.mark{display:grid;place-items:center;width:30px;height:32px;background:var(--ink);color:var(--surface);font-family:var(--mono);font-size:16px;border-radius:4px 4px 10px 4px}
.wordmark{font-size:17px;font-weight:500;letter-spacing:-.04em}
.eyebrow{font:500 10px/1.5 var(--mono);letter-spacing:.14em;color:var(--accent);margin:0 0 20px;text-transform:uppercase}
.button{display:inline-flex;align-items:center;justify-content:center;gap:20px;min-height:46px;padding:11px 20px;border:1px solid var(--ink);border-radius:5px;background:var(--ink);color:var(--surface);font-size:14px;font-weight:500;text-decoration:none;transition:transform .2s var(--ease),background .2s}
.button:hover{background:#41463c;color:var(--surface)}
.button:active{transform:scale(.98)}
.button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}
.button.secondary:hover{background:var(--tint)}
.skip-link{position:absolute;left:20px;top:12px;padding:10px 18px;background:var(--ink);color:var(--surface);transform:translateY(-160%);z-index:20}
.skip-link:focus{transform:none}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}
`;

export function brand(): string {
  return `<a class="brand" href="/"><span class="mark" aria-hidden="true">m</span><span class="wordmark">MemPersist</span></a>`;
}

export const FAVICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' rx='8' fill='%23282a25'/%3E%3Ctext x='9' y='28' font-family='monospace' font-size='28' fill='%23f7f6f2'%3Em%3C/text%3E%3C/svg%3E">`;
