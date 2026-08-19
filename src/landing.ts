const MCP_ENDPOINT = "https://mempersist.nextostaging.net/mcp";

const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: "/", label: "Home" },
  { href: "/whitepaper", label: "Whitepaper" },
  { href: "/architecture", label: "Architecture" },
  { href: "/security", label: "Security" },
  { href: "/adrs", label: "ADRs" },
  { href: "/about", label: "About" },
];

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

const LANDING_CSS = `
:root{color-scheme:dark;font-family:Outfit,Geist,"Segoe UI",system-ui,sans-serif;background:#061225;color:#eef4ff;font-synthesis:none;font-size:15.5px}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:#061225;line-height:1.6;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(52% 38% at 78% -6%,rgba(139,184,237,.14),transparent 62%),radial-gradient(40% 30% at 8% 110%,rgba(127,201,168,.07),transparent 60%)}
main.wrap{position:relative;z-index:1}
code,kbd{font-family:"JetBrains Mono","Geist Mono",ui-monospace,monospace}
nav{position:sticky;top:0;z-index:10;border-bottom:1px solid #1d324e;background:rgba(6,18,37,.9);backdrop-filter:blur(10px)}
.nav{max-width:900px;margin:0 auto;padding:12px 24px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.nav .brand{display:flex;align-items:center;gap:8px;margin-right:auto}
.nav .mark{display:grid;place-items:center;width:22px;height:22px;border:1px solid #48688f;background:#102746;color:#dceaff;font-size:11px;font-weight:800}
.nav .wordmark{font-size:13px;font-weight:700;letter-spacing:.02em}
.nav a{color:#91a4bd;text-decoration:none;font-size:13px;font-weight:600;transition:color .18s}
.nav a:hover{color:#dceaff}
.nav a.active{color:#dceaff;text-decoration:underline;text-underline-offset:4px}
.wrap{max-width:880px;margin:0 auto;padding:64px 24px 88px}
.eyebrow{margin:0 0 10px;color:#91add2;font-family:"JetBrains Mono","Geist Mono",ui-monospace,monospace;font-size:11px;font-weight:700;letter-spacing:.2em}
h1{margin:0;font-size:clamp(30px,6vw,46px);font-weight:750;letter-spacing:-.045em;line-height:1.03}
.lead{margin:18px 0 0;color:#aebed4;font-size:16.5px;max-width:56ch}
.endpoint{margin:30px 0 0;padding:15px 18px;border:1px solid #29415f;background:#0a1930;color:#b6d2f5;font-size:13px;word-break:break-all;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
h2{margin:56px 0 0;font-size:clamp(20px,3.4vw,27px);font-weight:700;letter-spacing:-.025em}
h3{margin:30px 0 8px;font-size:15px;font-weight:700}
p{color:#b6c6dc;font-size:14.5px}
ul,ol{padding-left:20px;color:#b6c6dc;font-size:14.5px}
li{margin:9px 0}
.code{margin:14px 0 0;padding:15px 18px;border:1px solid #22395a;background:#081527;color:#dceaff;font-size:13px;overflow-x:auto;white-space:pre;border-radius:6px}
.note{margin:20px 0 0;padding:14px 18px;border:1px solid #22395a;border-left:3px solid #7fc9a8;background:#0a1930;color:#aebed4;font-size:13px;border-radius:0 6px 6px 0}
table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px}
th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #1d324e;color:#b6c6dc}
th{color:#dce8f8;font-family:"JetBrains Mono","Geist Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.1em}
a{color:#8bb8ed}
h2 i.ph{display:inline-block;margin-right:10px;color:#8bb8ed;font-size:.85em;vertical-align:1px}
.diagram{margin:22px 0 0;padding:16px;border:1px solid #22395a;background:#081527;border-radius:8px;overflow-x:auto}
.diagram svg{display:block;width:100%;height:auto;max-width:720px;margin:0 auto}
.diagram text{font-family:"JetBrains Mono","Geist Mono",ui-monospace,monospace}
::selection{background:rgba(139,184,237,.28)}
footer{margin-top:72px;padding-top:22px;border-top:1px solid #1d324e;color:#7d92af;font-size:12px}
.reveal{opacity:0;transform:translateY(16px);transition:opacity .5s cubic-bezier(.16,1,.3,1),transform .5s cubic-bezier(.16,1,.3,1)}
.reveal.in{opacity:1;transform:none}
@media(max-width:640px){.wrap{padding:36px 18px 60px}.nav{padding:10px 18px;gap:12px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.reveal{opacity:1;transform:none;transition:none}}
`;

function page(title: string, body: string, active: string): string {
  const nav = `<nav><div class="nav"><div class="brand"><span class="mark">M</span><span class="wordmark">MemPersist</span></div>
${NAV_ITEMS.map(
  (item) =>
    `<a href="${item.href}"${item.href === active ? ' class="active"' : ""}>${item.label}</a>`,
).join("\n")}
</div></nav>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="MemPersist — durable AI conversation memory for ChatGPT and coding agents.">
<title>${escapeHtml(title)} · MemPersist</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;750;800&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.1/src/regular/style.css">
<style>${LANDING_CSS}</style></head>
<body>${nav}<main class="wrap">${body}</main>
<script>
(function () {
  var items = document.querySelectorAll("main.wrap > *");
  if (!("IntersectionObserver" in window)) return;
  items.forEach(function (el, index) {
    el.classList.add("reveal");
    el.style.transitionDelay = Math.min(index * 60, 300) + "ms";
  });
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.02 });
  items.forEach(function (el) { observer.observe(el); });
})();
</script>
</body></html>`;
}

export function landingPage(): Response {
  const body = `
  <header>
    <p class="eyebrow">DURABLE AI MEMORY</p>
    <h1>Conversation memory that survives the next session.</h1>
    <p class="lead">MemPersist stores high-fidelity AI conversation history, retrieves compact original context, and accepts intentional MCP writes. It works with any MCP-compatible client — ChatGPT, Codex, Claude Code, Cursor, and IDE extensions. The archive is yours, per account.</p>
    <div class="endpoint"><code>${escapeHtml(MCP_ENDPOINT)}</code></div>
  </header>

  <section>
    <h2><i class="ph ph-chat-circle-text" aria-hidden="true"></i> Connect ChatGPT (Developer mode)</h2>
    <p>MemPersist is not in the official ChatGPT plugin catalog. Connect it as a custom MCP app from Developer mode — the same endpoint works with every other MCP client too:</p>
    <ol>
      <li>Open ChatGPT and go to <strong>Settings → Developer</strong>.</li>
      <li>Select <strong>Custom MCP app</strong> (or enable Developer mode and add a custom app).</li>
      <li>Paste the endpoint: <code>${escapeHtml(MCP_ENDPOINT)}</code></li>
      <li>Complete the OAuth prompt and enter the email tied to your archive.</li>
    </ol>
    <div class="note">The consent page asks for your email, not a token. The same email reconnects to the same archive on any client.</div>
  </section>

  <section>
    <h2><i class="ph ph-terminal-window" aria-hidden="true"></i> Connect coding agents</h2>
    <h3>Codex CLI</h3>
    <p>Add to <code>~/.codex/config.toml</code> (or a project-scoped <code>.codex/config.toml</code>):</p>
    <div class="code">[mcp_servers.mempersist]
type = "remote"
url = "${escapeHtml(MCP_ENDPOINT)}"</div>
    <p>Then authorize once:</p>
    <div class="code">codex mcp login mempersist</div>
    <h3>Claude Code</h3>
    <div class="code">claude mcp add --transport http mempersist ${escapeHtml(MCP_ENDPOINT)}</div>
    <p>Complete the OAuth prompt with your email. Codex CLI, ChatGPT desktop, and the IDE extension share the same Codex configuration.</p>
    <h3>Any other MCP client</h3>
    <p>Point any client that supports remote Streamable HTTP MCP servers at the endpoint above and authorize with your email. Cursor, JetBrains, VS Code extensions, and custom tooling all work the same way.</p>
  </section>

  <section>
    <h2><i class="ph ph-book-open-text" aria-hidden="true"></i> Memory conventions</h2>
    <p>For coding agents, keep memory organized and reviewable:</p>
    <ul>
      <li>Store into <code>project/&lt;slug&gt;</code> namespaces — the first write claims the name for your account.</li>
      <li>Record architecture decisions, breaking changes, deploy behavior changes, and incident root causes; skip routine commits.</li>
      <li>Events are conversations titled <code>EVENT &lt;YYYY-MM-DD&gt; &lt;summary&gt;</code>, tagged <code>events</code>.</li>
      <li>Search first (<code>memory_search</code>), verify with <code>memory_get_context</code>, then <code>memory_append</code> instead of duplicating.</li>
      <li>Pair with git — record the short commit hash with each change, note what it breaks and what must run, and tag <code>decision</code> / <code>breaking</code> / <code>incident</code> / <code>runbook</code>.</li>
      <li>Delete only on explicit user confirmation (<code>memory_delete_conversations</code> or <code>memory_empty_namespace</code>).</li>
      <li>Never invent memory; cite the conversation and revision ids returned by the tools.</li>
    </ul>
    <h3>Tools</h3>
    <table>
      <thead><tr><th>Tool</th><th>Use</th></tr></thead>
      <tbody>
        <tr><td><code>memory_search</code></td><td>find memories; tags + tag_mode filter</td></tr>
        <tr><td><code>memory_get_context</code></td><td>original messages around a hit</td></tr>
        <tr><td><code>memory_get_conversation</code></td><td>page a full conversation</td></tr>
        <tr><td><code>memory_list_conversations</code></td><td>metadata and tags</td></tr>
        <tr><td><code>memory_list_namespaces</code></td><td>namespaces your account owns</td></tr>
        <tr><td><code>memory_stats</code></td><td>counts and indexing health</td></tr>
        <tr><td><code>memory_store</code></td><td>durable new memory</td></tr>
        <tr><td><code>memory_append</code></td><td>extend a conversation, optimistic revision check</td></tr>
        <tr><td><code>memory_update_tags</code></td><td>change tags</td></tr>
        <tr><td><code>memory_delete_conversations</code></td><td>delete specific memories (confirmed)</td></tr>
        <tr><td><code>memory_empty_namespace</code></td><td>empty one namespace (exact confirmation)</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2><i class="ph ph-shield-check" aria-hidden="true"></i> Privacy and isolation</h2>
    <p>Namespaces are scoped per account: the same namespace name in another account is separate and invisible. Every tool only ever sees the namespaces your account owns. Raw and canonical conversation bodies live in private object storage; D1 holds only the catalog and disposable search data.</p>
  </section>

  <footer>MemPersist · OAuth 2.1 + PKCE · Streamable HTTP MCP · by <a href="https://github.com/ravhirizaldi">Ravhi Rizaldi</a></footer>`;
  return respond(page("MemPersist — durable AI conversation memory", body, "/"));
}

function searchFlowDiagram(): string {
  return `<div class="diagram"><svg viewBox="0 0 720 330" role="img" aria-label="Search pipeline diagram">
    <g font-size="12" fill="#dceaff">
      <rect x="40" y="10" width="300" height="44" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="190" y="37" text-anchor="middle">query</text>
    </g>
    <path d="M190 54 L190 84" stroke="#48688f" fill="none"/>
    <g font-size="11">
      <rect x="30" y="84" width="200" height="52" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="130" y="103" text-anchor="middle" fill="#b6d2f5">lexical · FTS</text>
      <text x="130" y="121" text-anchor="middle" fill="#8294ad">chunked text match</text>
      <rect x="260" y="84" width="220" height="52" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="370" y="103" text-anchor="middle" fill="#b6d2f5">semantic</text>
      <text x="370" y="121" text-anchor="middle" fill="#8294ad">Workers AI embed → Vectorize</text>
      <rect x="510" y="84" width="180" height="52" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="600" y="103" text-anchor="middle" fill="#b6d2f5">recent-canonical</text>
      <text x="600" y="121" text-anchor="middle" fill="#8294ad">unindexed revisions</text>
    </g>
    <path d="M130 136 L190 176" stroke="#48688f" fill="none"/>
    <path d="M370 136 L320 176" stroke="#48688f" fill="none"/>
    <path d="M600 136 L510 176" stroke="#48688f" fill="none"/>
    <g font-size="11">
      <rect x="40" y="176" width="280" height="48" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="180" y="196" text-anchor="middle" fill="#b6d2f5">candidate merge</text>
      <text x="180" y="212" text-anchor="middle" fill="#8294ad">deterministic chunk identity</text>
      <rect x="350" y="176" width="340" height="48" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="520" y="196" text-anchor="middle" fill="#b6d2f5">scope + rank</text>
      <text x="520" y="212" text-anchor="middle" fill="#8294ad">(user_id, namespace) check · hybrid score</text>
    </g>
    <path d="M320 200 L350 200" stroke="#48688f" fill="none"/>
    <g font-size="12">
      <rect x="180" y="254" width="360" height="44" rx="6" fill="#102746" stroke="#48688f"/>
      <text x="360" y="281" text-anchor="middle" fill="#dceaff">ranked results + degradation state</text>
    </g>
    <path d="M520 224 L360 254" stroke="#48688f" fill="none"/>
  </svg></div>`;
}

function architectureDiagram(): string {
  return `<div class="diagram"><svg viewBox="0 0 760 470" role="img" aria-label="Cloudflare architecture diagram">
    <g font-size="11">
      <rect x="40" y="12" width="360" height="46" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="220" y="30" text-anchor="middle" fill="#b6d2f5" font-size="12">clients</text>
      <text x="220" y="46" text-anchor="middle" fill="#8294ad">ChatGPT · Codex · Claude · Cursor</text>
      <rect x="560" y="12" width="160" height="46" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="640" y="30" text-anchor="middle" fill="#b6d2f5" font-size="12">KV</text>
      <text x="640" y="46" text-anchor="middle" fill="#8294ad">OAuth grants + CSRF</text>
    </g>
    <path d="M220 58 L220 96" stroke="#48688f" fill="none"/>
    <path d="M640 58 L640 96" stroke="#48688f" fill="none"/>
    <path d="M560 58 C480 70 470 96 430 108" stroke="#48688f" fill="none"/>
    <g font-size="12">
      <rect x="40" y="96" width="390" height="58" rx="6" fill="#0d1d34" stroke="#48688f"/>
      <text x="235" y="118" text-anchor="middle" fill="#dceaff">Worker · mempersist</text>
      <text x="235" y="136" text-anchor="middle" fill="#8294ad" font-size="11">Hono · MCP SDK v2 · OAuth 2.1 · Zod</text>
      <rect x="560" y="96" width="160" height="58" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="640" y="118" text-anchor="middle" fill="#b6d2f5" font-size="12">Queues</text>
      <text x="640" y="136" text-anchor="middle" fill="#8294ad" font-size="11">import · index · DLQ</text>
    </g>
    <path d="M430 125 L560 125" stroke="#48688f" fill="none"/>
    <path d="M560 154 L430 176" stroke="#48688f" fill="none"/>
    <g font-size="12">
      <rect x="40" y="200" width="210" height="58" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="145" y="222" text-anchor="middle" fill="#b6d2f5">R2</text>
      <text x="145" y="240" text-anchor="middle" fill="#8294ad" font-size="11">canonical archive</text>
      <rect x="275" y="200" width="210" height="58" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="380" y="222" text-anchor="middle" fill="#b6d2f5">D1</text>
      <text x="380" y="240" text-anchor="middle" fill="#8294ad" font-size="11">catalog + namespaces</text>
      <rect x="510" y="200" width="210" height="58" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="615" y="222" text-anchor="middle" fill="#b6d2f5">Vectorize</text>
      <text x="615" y="240" text-anchor="middle" fill="#8294ad" font-size="11">semantic index</text>
    </g>
    <path d="M145 154 L145 200" stroke="#48688f" fill="none"/>
    <path d="M380 154 L380 200" stroke="#48688f" fill="none"/>
    <path d="M615 154 L615 200" stroke="#48688f" fill="none"/>
    <path d="M615 258 L615 320" stroke="#48688f" fill="none"/>
    <g font-size="12">
      <rect x="40" y="320" width="210" height="58" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="145" y="342" text-anchor="middle" fill="#b6d2f5">Workers AI</text>
      <text x="145" y="360" text-anchor="middle" fill="#8294ad" font-size="11">bge-m3 embeddings</text>
      <rect x="275" y="320" width="210" height="58" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="380" y="342" text-anchor="middle" fill="#b6d2f5">FTS</text>
      <text x="380" y="360" text-anchor="middle" fill="#8294ad" font-size="11">lexical index in D1</text>
    </g>
    <path d="M380 320 L380 258" stroke="#48688f" fill="none"/>
    <path d="M145 258 L145 320" stroke="#48688f" fill="none"/>
    <g font-size="11">
      <rect x="510" y="320" width="210" height="58" rx="6" fill="#0d1d34" stroke="#29415f"/>
      <text x="615" y="338" text-anchor="middle" fill="#b6d2f5">100% Cloudflare</text>
      <text x="615" y="356" text-anchor="middle" fill="#8294ad">no external infrastructure</text>
    </g>
    <path d="M640 154 L640 200" stroke="#48688f" fill="none"/>
    <g font-size="11">
      <rect x="40" y="410" width="680" height="40" rx="6" fill="#0a1930" stroke="#22395a"/>
      <text x="380" y="428" text-anchor="middle" fill="#8294ad">Workers runtime · D1 · R2 · Vectorize · Workers AI · Queues · KV — all Cloudflare bindings</text>
      <text x="380" y="442" text-anchor="middle" fill="#7d92af" font-size="10">canonical writes → catalog → index queue → derived FTS/vectors (rebuildable)</text>
    </g>
  </svg></div>`;
}

function whitepaperPage(): Response {
  const body = `
  <p class="eyebrow">WHITEPAPER</p>
  <h1>Designing durable AI conversation memory</h1>
  <p class="lead">MemPersist treats memory as a first-class archive: canonical, versioned, rebuildable, and explicitly written — not scraped.</p>

  <section>
    <h2>Problem</h2>
    <p>AI sessions are ephemeral. Context windows reset, exports are static snapshots, and every new session re-derives what previous sessions already decided. The result is repeated work, invented history, and decisions that drift. Existing "memory" features are either opaque, non-portable, or scrape conversations the user never intended to persist.</p>
  </section>

  <section>
    <h2>Principles</h2>
    <ul>
      <li><strong>Intentional writes.</strong> Memory enters through explicit MCP tools or an explicit ChatGPT export import — never automatic interception.</li>
      <li><strong>Canonical first.</strong> Original and normalized conversations are archived durably before any catalog or index is updated; an index failure never rolls back a canonical write.</li>
      <li><strong>Disposable derived data.</strong> Embeddings, FTS rows, and chunks rebuild from canonical content. Nothing derived is ever the source of truth.</li>
      <li><strong>Deterministic identity.</strong> Content hashes, revision ids, and chunk ids are derived, so retries, deduplication, and resume are safe.</li>
    </ul>
  </section>

  <section>
    <h2>Storage model</h2>
    <ul>
      <li><strong>R2</strong> holds immutable canonical revision manifests and conversation segments, keyed by content-derived hashes.</li>
      <li><strong>D1</strong> is the operational catalog: conversations, revisions, imports, jobs, and per-account namespaces.</li>
      <li><strong>Vectorize + FTS + chunks</strong> are derived search structures pinned to an explicit generation; the strategy, model, and dimensions are recorded.</li>
    </ul>
  </section>

  <section>
    <h2>Multi-account isolation</h2>
    <p>Each account owns one or more namespaces. The same namespace name may exist in another account with fully separated data; every read, write, and delete is scoped by <code>(user_id, namespace)</code>. Access is OAuth 2.1 with PKCE S256.</p>
  </section>

  <section>
    <h2>Retrieval</h2>
    <p>Hybrid retrieval combines lexical FTS, semantic vector search, and a bounded recent-canonical fallback for unindexed writes. Ranking fuses the channels deterministically and reports degraded channels instead of silently returning partial results.</p>
  </section>

  <section>
    <h2>Trust boundaries</h2>
    <p>All external JSON, query, and path inputs are validated with Zod. Structured logs carry event names, ids, and paths only — never conversation bodies, queries, tokens, or authorization headers. Imports are parsed leniently and recorded per-item, so unknown ChatGPT structures remain recoverable.</p>
  </section>

  <section>
    <h2><i class="ph ph-magnifying-glass" aria-hidden="true"></i> How search works</h2>
    <p>A query flows through three independent retrieval channels that are fused and ranked in one pass:</p>
    <ol>
      <li><strong>Lexical (FTS).</strong> The query is tokenized and matched against chunked conversation text in the FTS index.</li>
      <li><strong>Semantic.</strong> Query variants are embedded with Workers AI (bge-m3) and matched against the Vectorize index.</li>
      <li><strong>Recent-canonical.</strong> A bounded fallback scans the newest unindexed revisions directly from canonical storage, so fresh writes are searchable before indexing finishes.</li>
    </ol>
    <p>Channel results are merged by deterministic chunk identity, then every candidate is verified against the caller's <code>(user_id, namespace)</code> scope before ranking. The final score combines lexical position, semantic similarity, and recency evidence; a channel that fails is reported as degraded instead of silently returning partial results.</p>
    ${searchFlowDiagram()}
  </section>

  <section>
    <h2>Scope and limitations</h2>
    <ul>
      <li>Authentication is email-only; there is no email verification, billing, or organization support.</li>
      <li>V1 targets single-operator deployments and coding-agent workflows, not enterprise multi-tenant SaaS.</li>
      <li>Official app-store publishing is pending; the endpoint works today as a custom MCP app in ChatGPT Developer mode and in any other MCP client.</li>
    </ul>
  </section>

  <footer>MemPersist · v0.1 · Whitepaper</footer>`;
  return respond(page("Whitepaper", body, "/whitepaper"));
}

function architecturePage(): Response {
  const body = `
  <p class="eyebrow">ARCHITECTURE</p>
  <h1>Cloudflare-native, clean-room</h1>
  <p class="lead">Everything runs on Cloudflare Workers — no external infrastructure. R2 holds canonical truth, D1 is the catalog, derived indexes are rebuildable, and OAuth-protected MCP sits on top.</p>

  ${architectureDiagram()}

  <section>
    <h2><i class="ph ph-cloud-check" aria-hidden="true"></i> Cloudflare services</h2>
    <table>
      <thead><tr><th>Service</th><th>Role</th></tr></thead>
      <tbody>
        <tr><td>Workers runtime</td><td>HTTP dispatch, MCP transport, queue consumers, all application logic</td></tr>
        <tr><td>R2</td><td>durable canonical archive: revision manifests and conversation segments</td></tr>
        <tr><td>D1</td><td>operational catalog: conversations, revisions, imports, jobs, users, namespaces, FTS rows</td></tr>
        <tr><td>Vectorize</td><td>semantic index over chunk embeddings</td></tr>
        <tr><td>Workers AI</td><td>bge-m3 embedding generation for the semantic channel</td></tr>
        <tr><td>Queues</td><td>import and index orchestration with retries and a dead-letter queue</td></tr>
        <tr><td>KV</td><td>OAuth grants, PKCE/CSRF state, dynamic client registration</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2><i class="ph ph-stack" aria-hidden="true"></i> Module map</h2>
    <table>
      <thead><tr><th>Module</th><th>Responsibility</th></tr></thead>
      <tbody>
        <tr><td><code>chatgpt.ts / json-stream.ts</code></td><td>untrusted source parsing, lossless normalization</td></tr>
        <tr><td><code>storage.ts</code></td><td>canonical R2 + D1 catalog writes/reads</td></tr>
        <tr><td><code>chunking.ts</code></td><td>deterministic derived chunk construction</td></tr>
        <tr><td><code>indexing.ts / search.ts</code></td><td>disposable indexes and hybrid ranking</td></tr>
        <tr><td><code>jobs.ts</code></td><td>uploads, durable jobs, Queue orchestration, retries</td></tr>
        <tr><td><code>retrieval.ts</code></td><td>canonical context/page reconstruction</td></tr>
        <tr><td><code>mcp.ts / app.ts / oauth.ts</code></td><td>presentation and authentication only</td></tr>
        <tr><td><code>index.ts</code></td><td>Worker transport dispatch and queue entrypoint</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>Invariants</h2>
    <ul>
      <li>Original imports and canonical revisions live durably in R2; D1 is never the only transcript archive.</li>
      <li>Canonical R2 writes complete before D1 catalog success; cataloging completes before indexing is queued.</li>
      <li>Index failure never rolls back or misreports a canonical write.</li>
      <li>Every vector and FTS row maps to a deterministic chunk and canonical source range.</li>
      <li>Imports and queue handlers are idempotent, resumable, and safe under at-least-once delivery.</li>
      <li>Alternate ChatGPT branches and unknown source fields remain recoverable.</li>
    </ul>
  </section>

  <section>
    <h2>Stack</h2>
    <ul>
      <li>TypeScript, ES modules, strict typing, Cloudflare Workers runtime</li>
      <li>Hono (HTTP), official MCP SDK v2, Zod at trust boundaries, Vitest</li>
      <li>Bindings: D1, R2, Vectorize, Workers AI (embeddings), Queues, KV (OAuth state)</li>
      <li>Yarn only; Node APIs only behind <code>nodejs_compat</code> with a concrete need</li>
    </ul>
  </section>

  <footer>MemPersist · Architecture</footer>`;
  return respond(page("Architecture", body, "/architecture"));
}

function securityPage(): Response {
  const body = `
  <p class="eyebrow">SECURITY</p>
  <h1>Threat model and controls</h1>
  <p class="lead">MemPersist holds sensitive conversation history. The primary risks are unauthorized reads/writes, leaked tokens, email-guessing authorization, malicious imports, oversized input, log leakage, and accidental canonical deletion.</p>

  <section>
    <h2>Controls</h2>
    <ul>
      <li><code>/mcp</code> uses OAuth 2.1 authorization code with PKCE; operator APIs require an operator access credential that never reaches the browser.</li>
      <li>Access tokens are SHA-256 hashed before constant-time comparison; operator secrets are stored outside source control.</li>
      <li>ChatGPT access uses OAuth 2.1 authorization code with PKCE S256; the provider stores only hashes and encrypts grant props.</li>
      <li>The consent page uses a double-submit CSRF cookie, HTML-escapes client metadata, and denies framing, external content, and referrers.</li>
      <li>Email is the only identity credential — anyone who knows an account email can authorize a client for it. No password or email verification exists.</li>
      <li>Authentication runs before protected bodies are parsed; Zod validates every external input.</li>
      <li>Size limits: JSON writes 1 MiB, direct imports 16 MiB, multipart parts 16 MiB, MCP responses 64 KiB.</li>
      <li>R2 is private; no public bucket, presigned anonymous upload, or wildcard CORS.</li>
      <li>Structured logs contain event names, request/job ids, paths, and error categories — never bodies, queries, tokens, or authorization headers.</li>
    </ul>
  </section>

  <section>
    <h2>Isolation</h2>
    <p>Namespaces are per-account and the same name in another account is separate and invisible. Deletion is scoped by <code>(user_id, namespace)</code> and requires exact confirmations on destructive tools. Derived indexes are disposable; canonical data is never silently redacted or rewritten.</p>
  </section>

  <footer>MemPersist · Security</footer>`;
  return respond(page("Security", body, "/security"));
}

function adrsPage(): Response {
  const adrs: Array<[string, string]> = [
    ["0001", "Clean-room platform, no Engram reuse"],
    ["0002", "R2 canonical store"],
    ["0003", "D1 operational catalog"],
    ["0004", "Hybrid retrieval"],
    ["0005", "bge-m3 embeddings"],
    ["0006", "Queue-bounded processing"],
    ["0007", "Index generations"],
    ["0008", "ChatGPT OAuth 2.1"],
    ["0009", "Recent canonical fallback"],
    ["0010", "Normalized hybrid ranking"],
    ["0011", "Paraphrase-aware recent ranking"],
    ["0012", "Tombstone-first memory deletion"],
    ["0013", "Tag metadata"],
    ["0014", "FTS query construction"],
    ["0015", "Specificity-aware ranking"],
    ["0016", "Tag mutation and semantic diagnostics"],
    ["0017", "Message-boundary chunking"],
    ["0018", "Query-side semantic representations"],
    ["0019", "Evidence-sensitive semantic weighting"],
    ["0020", "Simple email SaaS authorization"],
    ["0021", "Multi-namespace accounts"],
    ["0022", "User-scoped namespaces"],
    ["0023", "user_id in vectorize metadata"],
  ];
  const rows = adrs
    .map(
      ([number, title]) =>
        `<tr><td><code>${number}</code></td><td>${escapeHtml(title)}</td><td>Accepted</td></tr>`,
    )
    .join("\n");
  const body = `
  <p class="eyebrow">ARCHITECTURE DECISION RECORDS</p>
  <h1>Accepted decisions</h1>
  <p class="lead">Every significant architecture decision is recorded as an ADR with status and context. Accepted history is never rewritten; new decisions supersede old ones.</p>
  <table>
    <thead><tr><th>ADR</th><th>Decision</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <footer>MemPersist · ADRs</footer>`;
  return respond(page("Architecture decision records", body, "/adrs"));
}

function aboutPage(): Response {
  const body = `
  <p class="eyebrow">ABOUT</p>
  <h1>Ravhi Rizaldi</h1>
  <p class="lead">Software engineer building AI systems, distributed backends, and engineering tools. Based in Indonesia.</p>

  <section>
    <h2>Creator of MemPersist</h2>
    <p>MemPersist is designed around a simple idea: AI memory should be durable, explicit, and portable. It stores high-fidelity conversation history on Cloudflare, rebuilds derived search indexes from canonical data, and exposes itself to any MCP-compatible client through OAuth-protected Streamable HTTP.</p>
  </section>

  <section>
    <h2>Also working on</h2>
    <ul>
      <li><strong>ASTARA Workbench</strong> — a desktop simulation and flight-software workbench for an aerospace project.</li>
      <li>AI systems, distributed backends, and engineering tooling across personal and client work.</li>
    </ul>
  </section>

  <section>
    <h2>Find me</h2>
    <ul>
      <li>GitHub: <a href="https://github.com/ravhirizaldi">github.com/ravhirizaldi</a></li>
    </ul>
  </section>

  <footer>MemPersist · About</footer>`;
  return respond(page("About", body, "/about"));
}

function respond(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src data: https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

export const landingRoutes: Record<string, () => Response> = {
  "/": landingPage,
  "/whitepaper": whitepaperPage,
  "/architecture": architecturePage,
  "/security": securityPage,
  "/adrs": adrsPage,
  "/about": aboutPage,
};
