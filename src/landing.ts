import { localeHeaders, messages, type Locale } from "./i18n";
import { localizePageMarkup } from "./locales/pages-id";
import { BASE_CSS, brand, FAVICON } from "./ui";
import { SITE_CSS, SITE_SCRIPT } from "./site";

const MCP_ENDPOINT = "https://mempersist.codifiedtech.id/mcp";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function page(title: string, body: string, active: string, locale: Locale, intro = ""): string {
  const t = messages(locale);
  const navItems = [
    { href: "/", label: t.shared.home },
    { href: "/whitepaper", label: t.shared.whitepaper },
    { href: "/architecture", label: t.shared.architecture },
    { href: "/security", label: t.shared.security },
    { href: "/adrs", label: t.shared.adrs },
    { href: "/about", label: t.shared.about },
  ];
  // The input is trusted template markup, never user content. Generate a static
  // contents list so document navigation also works without JavaScript.
  const sections: Array<{ id: string; label: string }> = [];
  const content = body
    .replace(/<h2>([\s\S]*?)<\/h2>/g, (_match: string, heading: string) => {
      const label = heading.replace(/<[^>]*>/g, "").trim();
      const id = `section-${sections.length + 1}`;
      sections.push({ id, label });
      return `<h2 id="${id}" tabindex="-1">${heading}</h2>`;
    })
    .replace(
      /<table>/g,
      `<div class="table-scroll" tabindex="0" role="region" aria-label="${t.shared.referenceTable}"><table>`,
    )
    .replace(/<\/table>/g, "</table></div>");
  const toc = sections.length
    ? `<nav class="toc" aria-label="${t.shared.onThisPage}"><p>${t.shared.onThisPageLabel}</p>${sections.map(({ id, label }) => `<a href="#${id}">${escapeHtml(label)}</a>`).join("")}</nav>`
    : `<aside class="toc"><p>${t.shared.projectNotes}</p><a href="/architecture">${t.shared.readArchitecture}</a><a href="/whitepaper">${t.shared.readWhitepaper}</a></aside>`;
  const language = `<nav class="language-switch" aria-label="${t.shared.language}"><a href="/language/en?return_to=${encodeURIComponent(active)}" lang="en"${locale === "en" ? ' aria-current="true"' : ""}>EN</a><span aria-hidden="true">/</span><a href="/language/id?return_to=${encodeURIComponent(active)}" lang="id"${locale === "id" ? ' aria-current="true"' : ""}>ID</a></nav>`;
  const nav = `<nav class="site-nav" aria-label="${t.shared.mainNav}"><div class="nav">
${brand(t.shared.homeLabel)}
<button type="button" class="nav-toggle" aria-controls="nav-links" aria-expanded="false" aria-label="${t.shared.menu}" hidden><span class="hamburger" aria-hidden="true"></span><span class="sr-only">${t.shared.menu}</span></button>
<div class="nav-links" id="nav-links">${navItems
    .map(
      (item) =>
        `<a href="${item.href}"${item.href === active ? ' aria-current="page"' : ""}>${item.label}</a>`,
    )
    .join("\n")}</div>
${language}<a class="nav-sign-in" href="/login">${t.shared.signIn}</a><a class="button nav-cta" href="/#connect">${t.shared.connect} <span aria-hidden="true">↗</span></a>
</div></nav>`;
  const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${t.shared.description}">
<title>${escapeHtml(title)} · MemPersist</title>
${FAVICON}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${BASE_CSS}${SITE_CSS}</style></head>
<body data-copied="${t.runtime.copied}" data-copy-success="${t.runtime.copiedFeedback}" data-copy-failed="${t.runtime.copyFailed}" data-decision-count="${t.runtime.decisionCount}"><a class="skip-link" href="#main-content">${t.shared.skip}</a>${nav}
<main id="main-content" class="wrap${active === "/" ? " home" : ""}" tabindex="-1">
<div class="page-meta"><span>${t.shared.memoryContext}</span><span>${active === "/" ? t.shared.ownArchive : `<a href="/">${t.shared.home}</a> / ${escapeHtml(navItems.find((item) => item.href === active)?.label ?? title)}`}</span></div>
${intro}<div class="reading-layout">${toc}<div class="document">${content}</div></div>
<footer><span>MemPersist · ${t.shared.durable}</span><div class="footer-links"><a href="/security">${t.shared.privacy}</a><a href="/about">${t.shared.creator}</a><a href="#main-content">${t.shared.backTop} ↑</a></div></footer>
</main><script>${SITE_SCRIPT}</script>
</body></html>`;
  return localizePageMarkup(locale, html);
}

function codeBlock(id: string, label: string, code: string): string {
  return `<div class="code-block"><div class="code-heading"><span>${escapeHtml(label)}</span><button class="copy-button" type="button" data-copy="${id}" aria-label="Copy ${escapeHtml(label)}" hidden>Copy</button></div><pre class="code" tabindex="0"><code id="${id}">${escapeHtml(code)}</code></pre></div>`;
}

export function landingPage(locale: Locale = "en"): Response {
  const intro = `
  <header class="hero">
    <div>
      <p class="eyebrow">DURABLE AI CONVERSATION MEMORY</p>
      <h1>Keep the context.<span>Continue the thought.</span></h1>
      <p class="lead">Your next session shouldn’t start from zero. Keep original conversations, recall what matters, and pick up where you left off.</p>
      <div class="hero-actions"><a class="button" href="#connect">Connect your client <span aria-hidden="true">↗</span></a><a class="text-link" href="/whitepaper">Read the thinking behind it</a></div>
      <p class="hero-caption">ChatGPT · Codex · Claude Code · Any MCP client</p>
    </div>
    <section class="archive-preview" data-demo aria-label="Interactive memory example">
      <div class="preview-top"><span>project / field-notes</span><span>ILLUSTRATIVE EXAMPLE</span></div>
      <div class="demo-controls" role="group" aria-label="Explore the memory lifecycle" hidden>
        <button type="button" data-step aria-pressed="true" aria-controls="example-save">01 Save</button><button type="button" data-step aria-pressed="false" aria-controls="example-find">02 Find</button><button type="button" data-step aria-pressed="false" aria-controls="example-continue">03 Continue</button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        <article class="demo-panel" id="example-save" data-example><p class="eyebrow">MEMORY_STORE / INTENTIONAL WRITES</p><h2>“Keep the decision, not just the summary.”</h2><p>Save the original conversation with its context. A new revision preserves what was said.</p></article>
        <article class="demo-panel" id="example-find" data-example><p class="eyebrow">MEMORY_SEARCH / HYBRID RETRIEVAL</p><h2>“Why did we choose object storage?”</h2><p>Search across words and meaning. Each result points back to a canonical conversation and source range.</p></article>
        <article class="demo-panel" id="example-continue" data-example><p class="eyebrow">MEMORY_GET_CONTEXT / ORIGINAL WORDS</p><h2>“Right. Let’s build on that.”</h2><p>Bring the surrounding messages into the next session. Verify the source before continuing the work.</p></article>
      </div>
      <div class="preview-bottom"><span>Original context. Not invented history.</span><span>01 — 03</span></div>
    </section>
  </header>
  <div class="endpoint" id="connect"><span class="endpoint-label">YOUR MCP ENDPOINT</span><code id="mcp-endpoint">${escapeHtml(MCP_ENDPOINT)}</code><button class="copy-button" type="button" data-copy="mcp-endpoint" aria-label="Copy MCP endpoint" hidden>Copy endpoint</button></div>
  <p class="copy-feedback" id="copy-feedback" role="status" aria-live="polite"></p>
  <section class="auth-panel">
    <div>
      <p class="eyebrow">EMAIL-ONLY ACCESS</p>
      <h2>One email. No password.</h2>
      <p>MemPersist sends a one-use magic link to your email. Existing archives reopen automatically, and a new archive is created after the first link is opened. The same email always reconnects you to the same private memory archive.</p>
    </div>
    <div class="auth-steps" aria-label="Passwordless access flow">
      <span><b>01</b> Enter your email</span>
      <span><b>02</b> Open the magic link</span>
      <span><b>03</b> Return to your archive</span>
    </div>
  </section>`;
  const body = `
  <section>
    <h2>Connect ChatGPT</h2>
    <p>MemPersist is not in the official ChatGPT plugin catalog. Connect it as a custom MCP app from Developer mode — the same endpoint works with every other MCP client too:</p>
    <ol>
      <li>Open ChatGPT and go to <strong>Settings → Developer</strong>.</li>
      <li>Select <strong>Custom MCP app</strong> (or enable Developer mode and add a custom app).</li>
      <li>Paste the endpoint: <code>${escapeHtml(MCP_ENDPOINT)}</code></li>
      <li>Complete the OAuth prompt and enter your email. Existing archives reconnect automatically; a new archive is created after the first link is opened.</li>
    </ol>
    <div class="note">A one-use magic link is sent to your email. No password is created or stored, and the same email reconnects you to the same archive on any client.</div>
  </section>

  <section>
    <h2>Connect coding agents</h2>
    <h3>Codex CLI</h3>
    <p>Add to <code>~/.codex/config.toml</code> (or a project-scoped <code>.codex/config.toml</code>):</p>
    ${codeBlock("codex-config", "Codex configuration · TOML", `[mcp_servers.mempersist]\ntype = "remote"\nurl = "${MCP_ENDPOINT}"`)}
    <p>Then authorize with your email through the one-use magic-link flow:</p>
    ${codeBlock("codex-login", "Codex authorization · Shell", "codex mcp login mempersist")}
    <h3>Claude Code</h3>
    ${codeBlock("claude-config", "Claude Code · Shell", `claude mcp add --transport http mempersist ${MCP_ENDPOINT}`)}
    <p>Complete the OAuth prompt with your email. If you reconnect later, request a fresh magic link; your archive remains tied to the same email. Codex CLI, ChatGPT desktop, and the IDE extension share the same Codex configuration.</p>
    <h3>Any other MCP client</h3>
    <p>Point any client that supports remote Streamable HTTP MCP servers at the endpoint above and authorize with your email through the magic-link flow. Cursor, JetBrains, VS Code extensions, and custom tooling all work the same way.</p>
  </section>

  <section>
    <h2>Memory conventions</h2>
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
        <tr><td><code>memory_get_conversations</code></td><td>batch up to 20 known conversations</td></tr>
        <tr><td><code>memory_list_conversations</code></td><td>metadata and tags</td></tr>
        <tr><td><code>memory_list_revisions</code></td><td>immutable revision history of one conversation</td></tr>
        <tr><td><code>memory_resolve_conversations</code></td><td>resolve up to 20 exact titles without semantic search</td></tr>
        <tr><td><code>memory_build_context</code></td><td>compile revision-pinned context pack from owners and search evidence</td></tr>
        <tr><td><code>memory_list_namespaces</code></td><td>namespaces your account owns</td></tr>
        <tr><td><code>memory_stats</code></td><td>counts and indexing health</td></tr>
        <tr><td><code>memory_store</code></td><td>durable new memory</td></tr>
        <tr><td><code>memory_append</code></td><td>extend a conversation, optimistic revision check</td></tr>
        <tr><td><code>memory_replace</code></td><td>replace its transcript, optimistic revision check</td></tr>
        <tr><td><code>memory_restore_revision</code></td><td>restore historical revision, optimistic revision check</td></tr>
        <tr><td><code>memory_copy_conversations</code></td><td>lossless copy into another owned namespace</td></tr>
        <tr><td><code>memory_update_tags</code></td><td>change tags</td></tr>
        <tr><td><code>memory_delete_conversations</code></td><td>delete specific memories (confirmed)</td></tr>
        <tr><td><code>memory_empty_namespace</code></td><td>empty one namespace (exact confirmation)</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>Privacy and isolation</h2>
    <p>Namespaces are scoped per account: the same namespace name in another account is separate and invisible. Every tool only ever sees the namespaces your account owns. Raw and canonical conversation bodies live in private object storage; D1 holds only the catalog and disposable search data.</p>
  </section>`;
  return respond(page("Durable AI conversation memory", body, "/", locale, intro), locale);
}

function searchFlowDiagram(): string {
  return `<div class="diagram">
    <svg viewBox="0 0 900 500" role="img" aria-labelledby="search-diagram-title search-diagram-desc">
      <title id="search-diagram-title">MemPersist hybrid search pipeline</title>
      <desc id="search-diagram-desc">A query fans out to lexical, semantic, and recent-canonical sources, then candidates are merged, scoped, ranked, and returned with degradation state.</desc>
      <defs>
        <marker id="search-diagram-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
          <path d="M0 0L9 4.5L0 9Z" />
        </marker>
        <pattern id="search-diagram-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" />
        </pattern>
      </defs>
      <rect class="diagram-bg" x="0" y="0" width="900" height="500" rx="16" />
      <rect class="diagram-grid" x="1" y="1" width="898" height="498" rx="15" />

      <g class="diagram-header">
        <text x="40" y="36">RETRIEVAL PIPELINE</text>
        <text x="860" y="36" text-anchor="end">DETERMINISTIC + HYBRID</text>
      </g>
      <g class="diagram-node diagram-node--edge">
        <rect x="260" y="60" width="380" height="70" rx="10" />
        <circle cx="284" cy="84" r="5" />
        <text class="diagram-node-title" x="300" y="88">Query</text>
        <text class="diagram-node-meta" x="284" y="111">authenticated request · normalized terms · namespace</text>
      </g>

      <g class="diagram-band">
        <text x="40" y="164">01 / CANDIDATE SOURCES</text>
        <path d="M190 160H860" />
      </g>
      <g class="diagram-node diagram-node--durable">
        <rect x="40" y="184" width="250" height="84" rx="10" />
        <text class="diagram-node-kicker" x="64" y="210">LEXICAL</text>
        <text class="diagram-node-title" x="64" y="238">FTS5</text>
        <text class="diagram-node-meta" x="64" y="257">chunked text match</text>
      </g>
      <g class="diagram-node diagram-node--derived">
        <rect x="325" y="184" width="250" height="84" rx="10" />
        <text class="diagram-node-kicker" x="349" y="210">SEMANTIC</text>
        <text class="diagram-node-title" x="349" y="238">Workers AI → Vectorize</text>
        <text class="diagram-node-meta" x="349" y="257">embedding similarity</text>
      </g>
      <g class="diagram-node diagram-node--queue">
        <rect x="610" y="184" width="250" height="84" rx="10" />
        <text class="diagram-node-kicker" x="634" y="210">RECENT-CANONICAL</text>
        <text class="diagram-node-title" x="634" y="238">Fresh revisions</text>
        <text class="diagram-node-meta" x="634" y="257">unindexed coverage</text>
      </g>
      <path class="diagram-flow" d="M450 130V150H165V184" marker-end="url(#search-diagram-arrow)" />
      <path class="diagram-flow" d="M450 130V184" marker-end="url(#search-diagram-arrow)" />
      <path class="diagram-flow" d="M450 130V150H735V184" marker-end="url(#search-diagram-arrow)" />

      <g class="diagram-band">
        <text x="40" y="300">02 / MERGE + GOVERN</text>
        <path d="M174 296H860" />
      </g>
      <g class="diagram-node diagram-node--durable">
        <rect x="100" y="320" width="330" height="78" rx="10" />
        <text class="diagram-node-kicker" x="124" y="346">MERGE</text>
        <text class="diagram-node-title" x="124" y="374">Candidate set</text>
        <text class="diagram-node-meta" x="124" y="391">stable chunk identity · deduplication</text>
      </g>
      <g class="diagram-node diagram-node--auth">
        <rect x="470" y="320" width="330" height="78" rx="10" />
        <text class="diagram-node-kicker" x="494" y="346">SCOPE + RANK</text>
        <text class="diagram-node-title" x="494" y="374">Hybrid ordering</text>
        <text class="diagram-node-meta" x="494" y="391">(user_id, namespace) · score + boosts</text>
      </g>
      <path class="diagram-flow" d="M165 268V292L265 320" marker-end="url(#search-diagram-arrow)" />
      <path class="diagram-flow" d="M450 268V320" marker-end="url(#search-diagram-arrow)" />
      <path class="diagram-flow" d="M735 268V292L635 320" marker-end="url(#search-diagram-arrow)" />
      <path class="diagram-flow" d="M430 359H470" marker-end="url(#search-diagram-arrow)" />

      <g class="diagram-node diagram-node--edge">
        <rect x="220" y="430" width="460" height="48" rx="10" />
        <text class="diagram-node-title" x="450" y="459" text-anchor="middle">Ranked results + degradation state</text>
      </g>
      <path class="diagram-flow" d="M635 398V414L450 430" marker-end="url(#search-diagram-arrow)" />
    </svg>
  </div>`;
}

function architectureDiagram(): string {
  return `<div class="diagram">
    <svg viewBox="0 0 900 570" role="img" aria-labelledby="architecture-diagram-title architecture-diagram-desc">
      <title id="architecture-diagram-title">MemPersist request, storage, and indexing flow</title>
      <desc id="architecture-diagram-desc">Clients connect to the MCP Worker. The Worker writes canonical data to R2 and the D1 catalog, then queues rebuildable lexical and semantic indexing work.</desc>
      <defs>
        <marker id="diagram-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
          <path d="M0 0L9 4.5L0 9Z" />
        </marker>
        <pattern id="diagram-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" />
        </pattern>
      </defs>
      <rect class="diagram-bg" x="0" y="0" width="900" height="570" rx="16" />
      <rect class="diagram-grid" x="1" y="1" width="898" height="568" rx="15" />

      <g class="diagram-header">
        <text x="40" y="36">REQUEST + STORAGE FLOW</text>
        <text x="860" y="36" text-anchor="end">CLOUDFLARE / MEMPERSIST</text>
      </g>

      <g class="diagram-band">
        <text x="40" y="78">01 / EDGE</text>
        <path d="M112 74H860" />
      </g>
      <g class="diagram-node diagram-node--clients">
        <rect x="40" y="104" width="230" height="78" rx="10" />
        <circle cx="62" cy="128" r="5" />
        <text class="diagram-node-title" x="78" y="132">Clients</text>
        <text class="diagram-node-meta" x="62" y="157">ChatGPT · Codex · Claude · Cursor</text>
      </g>
      <g class="diagram-node diagram-node--edge">
        <rect x="325" y="104" width="340" height="78" rx="10" />
        <circle cx="347" cy="128" r="5" />
        <text class="diagram-node-title" x="363" y="132">MCP edge / Worker</text>
        <text class="diagram-node-meta" x="347" y="157">Hono · OAuth 2.1 · MCP SDK v2</text>
      </g>
      <g class="diagram-node diagram-node--auth">
        <rect x="720" y="104" width="140" height="78" rx="10" />
        <circle cx="742" cy="128" r="5" />
        <text class="diagram-node-title" x="758" y="132">KV</text>
        <text class="diagram-node-meta" x="742" y="157">grants · PKCE · CSRF</text>
      </g>
      <path class="diagram-flow" d="M270 143H325" marker-end="url(#diagram-arrow)" />
      <path class="diagram-flow diagram-flow--auth" d="M720 143H665" marker-end="url(#diagram-arrow)" />

      <g class="diagram-band">
        <text x="40" y="222">02 / DURABLE PATH</text>
        <path d="M162 218H860" />
      </g>
      <g class="diagram-node diagram-node--durable">
        <rect x="40" y="248" width="250" height="90" rx="10" />
        <text class="diagram-node-kicker" x="64" y="276">CANONICAL</text>
        <text class="diagram-node-title" x="64" y="304">R2</text>
        <text class="diagram-node-meta" x="64" y="324">immutable archive</text>
      </g>
      <g class="diagram-node diagram-node--durable">
        <rect x="325" y="248" width="250" height="90" rx="10" />
        <text class="diagram-node-kicker" x="349" y="276">CATALOG</text>
        <text class="diagram-node-title" x="349" y="304">D1</text>
        <text class="diagram-node-meta" x="349" y="324">namespaces · revisions · jobs</text>
      </g>
      <g class="diagram-node diagram-node--queue">
        <rect x="610" y="248" width="250" height="90" rx="10" />
        <text class="diagram-node-kicker" x="634" y="276">ORCHESTRATION</text>
        <text class="diagram-node-title" x="634" y="304">Queues</text>
        <text class="diagram-node-meta" x="634" y="324">import · index · dead letter</text>
      </g>
      <path class="diagram-flow" d="M430 182V220L165 248" marker-end="url(#diagram-arrow)" />
      <path class="diagram-flow" d="M500 182V248" marker-end="url(#diagram-arrow)" />
      <path class="diagram-flow" d="M290 293H325" marker-end="url(#diagram-arrow)" />
      <path class="diagram-flow" d="M575 293H610" marker-end="url(#diagram-arrow)" />

      <g class="diagram-band">
        <text x="40" y="378">03 / REBUILDABLE INDEXES</text>
        <path d="M210 374H860" />
      </g>
      <g class="diagram-node diagram-node--derived">
        <rect x="40" y="404" width="250" height="90" rx="10" />
        <text class="diagram-node-kicker" x="64" y="432">EMBEDDINGS</text>
        <text class="diagram-node-title" x="64" y="460">Workers AI</text>
        <text class="diagram-node-meta" x="64" y="480">bge-m3 generation</text>
      </g>
      <g class="diagram-node diagram-node--derived">
        <rect x="325" y="404" width="250" height="90" rx="10" />
        <text class="diagram-node-kicker" x="349" y="432">LEXICAL</text>
        <text class="diagram-node-title" x="349" y="460">FTS5 / D1</text>
        <text class="diagram-node-meta" x="349" y="480">text search channel</text>
      </g>
      <g class="diagram-node diagram-node--derived">
        <rect x="610" y="404" width="250" height="90" rx="10" />
        <text class="diagram-node-kicker" x="634" y="432">SEMANTIC</text>
        <text class="diagram-node-title" x="634" y="460">Vectorize</text>
        <text class="diagram-node-meta" x="634" y="480">disposable vector index</text>
      </g>
      <path class="diagram-flow diagram-flow--derived" d="M675 338V360H165V404" marker-end="url(#diagram-arrow)" />
      <path class="diagram-flow diagram-flow--derived" d="M735 338V404" marker-end="url(#diagram-arrow)" />
      <path class="diagram-flow diagram-flow--derived" d="M795 338V360H735V404" marker-end="url(#diagram-arrow)" />
      <path class="diagram-flow diagram-flow--derived" d="M290 449H610" marker-end="url(#diagram-arrow)" />

      <g class="diagram-footer">
        <circle cx="48" cy="538" r="4" />
        <text x="62" y="542">canonical first</text>
        <path d="M210 538H250" />
        <text x="264" y="542">derived data is rebuildable</text>
        <text x="860" y="542" text-anchor="end">all services remain inside Cloudflare</text>
      </g>
    </svg>
  </div>`;
}

function whitepaperPage(locale: Locale = "en"): Response {
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
    <h2>How search works</h2>
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
        <li>Authentication is email-only and passwordless: registration and sign-in use one-use magic links sent to the account email; there is no billing or organization support.</li>
      <li>V1 targets single-operator deployments and coding-agent workflows, not enterprise multi-tenant SaaS.</li>
      <li>Official app-store publishing is pending; the endpoint works today as a custom MCP app in ChatGPT Developer mode and in any other MCP client.</li>
    </ul>
  </section>`;
  return respond(page("Whitepaper", body, "/whitepaper", locale), locale);
}

function architecturePage(locale: Locale = "en"): Response {
  const body = `
  <p class="eyebrow">ARCHITECTURE</p>
  <h1>Cloudflare-native, clean-room</h1>
  <p class="lead">Everything runs on Cloudflare Workers — no external infrastructure. R2 holds canonical truth, D1 is the catalog, derived indexes are rebuildable, and OAuth-protected MCP sits on top.</p>

  ${architectureDiagram()}

  <section>
    <h2>Cloudflare services</h2>
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
    <h2>Module map</h2>
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
  </section>`;
  return respond(page("Architecture", body, "/architecture", locale), locale);
}

function securityPage(locale: Locale = "en"): Response {
  const body = `
  <p class="eyebrow">SECURITY</p>
  <h1>Threat model and controls</h1>
  <p class="lead">MemPersist holds sensitive conversation history. The primary risks are unauthorized reads/writes, leaked tokens or magic links, mailbox compromise, malicious imports, oversized input, log leakage, and accidental canonical deletion.</p>

  <section>
    <h2>Controls</h2>
    <ul>
      <li><code>/mcp</code> uses OAuth 2.1 authorization code with PKCE; operator APIs require an operator access credential that never reaches the browser.</li>
      <li>Access tokens are SHA-256 hashed before constant-time comparison; operator secrets are stored outside source control.</li>
      <li>ChatGPT access uses OAuth 2.1 authorization code with PKCE S256 and a one-use email magic link; the provider stores only hashes and encrypts grant props.</li>
      <li>The consent page uses a double-submit CSRF cookie, HTML-escapes client metadata, and denies framing, external content, and referrers.</li>
      <li>Email is the only identity credential; authorization requires a one-use magic link sent to that address. No password or separate profile-verification flow exists.</li>
      <li>Dashboard sessions are hash-only, expire after 30 days, use a secure host-only cookie, and protect mutations with same-origin and session-derived CSRF checks.</li>
      <li>A pending account deletion keeps reading, export, logout, and cancellation available while every write returns <code>409 DELETION_PENDING</code>.</li>
      <li>Authentication runs before protected bodies are parsed; Zod validates every external input.</li>
      <li>Size limits: JSON writes 1 MiB, direct imports 16 MiB, multipart parts 16 MiB, MCP responses 64 KiB.</li>
      <li>R2 is private; no public bucket, presigned anonymous upload, or wildcard CORS.</li>
      <li>Structured logs contain event names, request/job ids, paths, and error categories — never bodies, queries, tokens, or authorization headers.</li>
    </ul>
  </section>

  <section>
    <h2>Isolation</h2>
    <p>Namespaces are per-account and the same name in another account is separate and invisible. Deletion is scoped by <code>(user_id, namespace)</code> and requires exact confirmations on destructive tools. Derived indexes are disposable; canonical data is never silently redacted or rewritten.</p>
  </section>`;
  return respond(page("Security", body, "/security", locale), locale);
}

function adrsPage(locale: Locale = "en"): Response {
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
    ["0024", "Magic-link MCP authentication"],
    ["0025", "Unified email continuation"],
    ["0026", "Browser interface localization"],
    ["0027", "Compact readback and verified writes"],
    ["0028", "Passwordless dashboard, export, and deletion jobs"],
    ["0029", "Bundled graph library for the memory map"],
    ["0030", "Revision restore head transitions"],
    ["0031", "Canonical conversation copy"],
  ];
  const rows = adrs
    .map(
      ([number, title]) =>
        `<tr data-decision><td><code>${number}</code></td><td>${escapeHtml(title)}</td><td><span class="accepted">Accepted</span></td></tr>`,
    )
    .join("\n");
  const body = `
  <p class="eyebrow">ARCHITECTURE DECISION RECORDS</p>
  <h1>Accepted decisions</h1>
  <p class="lead">Every significant architecture decision is recorded as an ADR with status and context. Accepted history is never rewritten; new decisions supersede old ones.</p>
  <div class="filter-bar" hidden><div><label for="decision-search">Find a decision</label><input id="decision-search" type="search" placeholder="Search by topic or number…" aria-controls="decisions" aria-describedby="decision-count" autocomplete="off"></div><button type="button" class="button secondary" id="clear-search">Clear</button></div>
  <div class="filter-meta"><span id="decision-count" role="status" aria-live="polite">${adrs.length} decisions</span><span>DESIGN LOG / V0.1</span></div>
  <table>
    <thead><tr><th>ADR</th><th>Decision</th><th>Status</th></tr></thead>
    <tbody id="decisions">${rows}</tbody>
  </table>
  <div class="empty-state" id="decision-empty" hidden><h3>No matching decisions</h3><p>Try “storage”, “OAuth”, or a decision number. Clear the search to see everything.</p></div>`;
  return respond(page("Architecture decision records", body, "/adrs", locale), locale);
}

function aboutPage(locale: Locale = "en"): Response {
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
  </section>`;
  return respond(page("About", body, "/about", locale), locale);
}

function respond(html: string, locale: Locale): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      ...localeHeaders(locale),
    },
  });
}

export const landingRoutes: Record<string, (locale?: Locale) => Response> = {
  "/": landingPage,
  "/whitepaper": whitepaperPage,
  "/architecture": architecturePage,
  "/security": securityPage,
  "/adrs": adrsPage,
  "/about": aboutPage,
};
