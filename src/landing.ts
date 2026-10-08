import { interpolate, localeHeaders, messages, type Locale } from "./i18n";
import { localizePageMarkup } from "./locales/pages-id";
import { BASE_CSS, brand, FAVICON } from "./ui";
import { CRITICAL_SITE_CSS } from "./site";
import { PUBLIC_ASSET_VERSION, PUBLIC_ORIGIN } from "./discovery";
import {
  MAX_DIRECT_IMPORT_BYTES,
  MAX_INLINE_JSON_WRITE_BYTES,
  MAX_MULTIPART_PART_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  RECOMMENDED_TOOL_OUTPUT_BYTES,
} from "./limits";

const SEO: Record<Locale, Record<string, { title: string; description: string }>> = {
  en: {
    "/": {
      title: "MemPersist — Durable AI conversation memory",
      description:
        "MemPersist keeps AI conversation memory durable, searchable, and portable across ChatGPT, Codex, Claude Code, and MCP clients.",
    },
    "/whitepaper": {
      title: "Whitepaper — Durable AI conversation memory",
      description:
        "Read the MemPersist whitepaper: a canonical, versioned, and rebuildable architecture for durable AI conversation memory.",
    },
    "/architecture": {
      title: "Architecture — Cloudflare-native AI memory",
      description:
        "Explore MemPersist’s Cloudflare-native architecture for canonical conversation storage, rebuildable indexes, and OAuth-protected MCP.",
    },
    "/security": {
      title: "Security — MemPersist",
      description:
        "Review MemPersist’s threat model, security controls, data boundaries, and recovery practices for sensitive AI conversation memory.",
    },
    "/privacy": {
      title: "Privacy — MemPersist",
      description:
        "Learn what account, conversation, authentication, and operational data MemPersist processes, why it processes it, and how users control it.",
    },
    "/terms": {
      title: "Terms — MemPersist",
      description:
        "Read the MemPersist service terms covering MCP access, account responsibility, intentional memory writes, deletion, availability, and acceptable use.",
    },
    "/adrs": {
      title: "Architecture decision records — MemPersist",
      description:
        "Read MemPersist’s accepted architecture decisions covering storage, retrieval, OAuth, indexing, and operational safety.",
    },
    "/about": {
      title: "About — MemPersist",
      description:
        "Learn about Ravhi Rizaldi, the engineer behind MemPersist and its durable AI conversation memory platform.",
    },
  },
  id: {
    "/": {
      title: "MemPersist — Memori percakapan AI tahan lama",
      description:
        "MemPersist menjaga memori percakapan AI tetap tahan lama, mudah dicari, dan portabel di ChatGPT, Codex, Claude Code, serta klien MCP.",
    },
    "/whitepaper": {
      title: "Makalah — Memori percakapan AI tahan lama",
      description:
        "Baca makalah MemPersist tentang arsitektur memori percakapan AI yang kanonis, berversi, dan dapat dibangun ulang.",
    },
    "/architecture": {
      title: "Arsitektur — Memori AI Cloudflare-native",
      description:
        "Pelajari arsitektur Cloudflare-native MemPersist untuk penyimpanan percakapan kanonis, indeks yang dapat dibangun ulang, dan MCP OAuth.",
    },
    "/security": {
      title: "Keamanan — MemPersist",
      description:
        "Tinjau model ancaman, kontrol keamanan, batas data, dan praktik pemulihan MemPersist untuk memori percakapan AI yang sensitif.",
    },
    "/privacy": {
      title: "Privasi — MemPersist",
      description:
        "Pelajari data akun, percakapan, autentikasi, dan operasional yang diproses MemPersist, tujuannya, serta kontrol pengguna.",
    },
    "/terms": {
      title: "Ketentuan — MemPersist",
      description:
        "Baca ketentuan layanan MemPersist tentang akses MCP, tanggung jawab akun, penulisan memori, penghapusan, ketersediaan, dan penggunaan yang dapat diterima.",
    },
    "/adrs": {
      title: "Keputusan arsitektur — MemPersist",
      description:
        "Baca keputusan arsitektur MemPersist tentang penyimpanan, pengambilan, OAuth, pengindeksan, dan keamanan operasional.",
    },
    "/about": {
      title: "Tentang — MemPersist",
      description:
        "Kenali Ravhi Rizaldi, insinyur di balik MemPersist dan platform memori percakapan AI yang tahan lama.",
    },
  },
};
const MCP_ENDPOINT = "https://mempersist.codifiedtech.id/mcp";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"] as const;

/** Renders a byte budget in the human-readable notation the public copy uses. */
function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value} ${BYTE_UNITS[unit]!}`;
}

function codeBlock(id: string, label: string, code: string): string {
  return `<div class="code-block"><div class="code-heading"><span>${escapeHtml(label)}</span><button class="copy-button" type="button" data-copy="${id}" hidden>Copy</button></div><pre class="code" tabindex="0"><code id="${id}">${escapeHtml(code)}</code></pre></div>`;
}

function page(title: string, body: string, active: string, locale: Locale, intro = ""): string {
  const t = messages(locale);
  const metadata = SEO[locale][active] ?? {
    title: `${title} · MemPersist`,
    description: t.shared.description,
  };
  const canonical = `${PUBLIC_ORIGIN}${active === "/" ? "/" : active}`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": active === "/" ? "WebSite" : "WebPage",
    name: metadata.title,
    description: metadata.description,
    url: canonical,
    inLanguage: locale,
    isPartOf: { "@type": "WebSite", name: "MemPersist", url: `${PUBLIC_ORIGIN}/` },
    publisher: { "@type": "Person", name: "Ravhi Rizaldi", url: `${PUBLIC_ORIGIN}/about` },
  }).replaceAll("<", "\\u003c");
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
${brand()}
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
<meta name="description" content="${escapeHtml(metadata.description)}">
<meta name="author" content="Ravhi Rizaldi">
<meta name="google-site-verification" content="mwzJlCt4rJwkhbnmNF0EDUELm14CZzPYQhI-YtcX_sA">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="theme-color" content="#f7f6f2">
<link rel="canonical" href="${escapeHtml(canonical)}">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:type" content="${active === "/" ? "website" : "article"}">
<meta property="og:site_name" content="MemPersist">
<meta property="og:title" content="${escapeHtml(metadata.title)}">
<meta property="og:description" content="${escapeHtml(metadata.description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:locale" content="${locale === "id" ? "id_ID" : "en_US"}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(metadata.title)}">
<meta name="twitter:description" content="${escapeHtml(metadata.description)}">
<script type="application/ld+json">${jsonLd}</script>
<title>${escapeHtml(metadata.title)}</title>
${FAVICON}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&display=optional" rel="stylesheet">
<style>${BASE_CSS}${CRITICAL_SITE_CSS}</style>
<link rel="preload" href="/site.css?v=${PUBLIC_ASSET_VERSION}" as="style" fetchpriority="high" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="/site.css?v=${PUBLIC_ASSET_VERSION}"></noscript></head>
<body data-copied="${t.runtime.copied}" data-copy-success="${t.runtime.copiedFeedback}" data-copy-failed="${t.runtime.copyFailed}" data-decision-count="${t.runtime.decisionCount}"><a class="skip-link" href="#main-content">${t.shared.skip}</a>${nav}
<main id="main-content" class="wrap${active === "/" ? " home" : ""}" tabindex="-1">
<div class="page-meta"><span>${t.shared.memoryContext}</span><span>${active === "/" ? t.shared.ownArchive : `<a href="/">${t.shared.home}</a> / ${escapeHtml(navItems.find((item) => item.href === active)?.label ?? title)}`}</span></div>
${intro}<div class="reading-layout">${toc}<div class="document">${content}</div></div>
<footer><span>MemPersist · ${t.shared.durable}</span><div class="footer-links"><a href="/privacy"${active === "/privacy" ? ' aria-current="page"' : ""}>${locale === "id" ? "Privasi" : "Privacy"}</a><a href="/terms"${active === "/terms" ? ' aria-current="page"' : ""}>${locale === "id" ? "Ketentuan" : "Terms"}</a><a href="/security">${t.shared.security}</a><a href="/about">${t.shared.creator}</a><a href="#main-content">${t.shared.backTop} ↑</a></div></footer>
</main><script src="/site.js?v=${PUBLIC_ASSET_VERSION}" defer></script>
</body></html>`;
  return localizePageMarkup(locale, html);
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
        <article class="demo-panel" id="example-find" data-example><p class="eyebrow">MEMORY_SEARCH / HYBRID RETRIEVAL</p><h2>“Why did we choose object storage?”</h2><p>Search words and meaning with namespace and tag filters. Each compact reference points back to a canonical conversation and source range; stable snapshot pages preserve the ranked order.</p></article>
        <article class="demo-panel" id="example-continue" data-example><p class="eyebrow">MEMORY_GET_CONTEXT / ORIGINAL WORDS</p><h2>“Right. Let’s build on that.”</h2><p>Bring the surrounding messages into the next session. Verify the source before continuing the work.</p></article>
      </div>
      <div class="preview-bottom"><span>Original context. Not invented history.</span><span>01 — 03</span></div>
    </section>
  </header>
  <div class="endpoint" id="connect"><span class="endpoint-label">YOUR MCP ENDPOINT</span><code id="mcp-endpoint">${escapeHtml(MCP_ENDPOINT)}</code><button class="copy-button" type="button" data-copy="mcp-endpoint" hidden>Copy endpoint</button></div>
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
        <tr><td><code>memory_search</code></td><td>find ranked memories; namespace + tags/tag_mode filters; stable opaque snapshot pagination</td></tr>
        <tr><td><code>memory_get_context</code></td><td>original messages around a hit</td></tr>
        <tr><td><code>memory_get_conversation</code></td><td>page a full conversation</td></tr>
        <tr><td><code>memory_get_messages</code></td><td>read-only exact source-node or optional message-key lookup; ordered 1–100, revision-pinned, opaque cursor</td></tr>
        <tr><td><code>memory_get_conversations</code></td><td>start with 1–20 requests; resume fairly with one opaque cursor</td></tr>
        <tr><td><code>memory_list_conversations</code></td><td>metadata and tags</td></tr>
        <tr><td><code>memory_list_revisions</code></td><td>immutable revision history of one conversation</td></tr>
        <tr><td><code>memory_resolve_conversations</code></td><td>resolve up to 20 exact titles without semantic search</td></tr>
        <tr><td><code>memory_build_context</code></td><td>compile revision-pinned context pack from owners and search evidence</td></tr>
        <tr><td><code>memory_import_status</code></td><td>import progress, duplicate, or failure</td></tr>
        <tr><td><code>memory_list_namespaces</code></td><td>namespaces your account owns</td></tr>
        <tr><td><code>memory_stats</code></td><td>counts and indexing health</td></tr>
        <tr><td><code>memory_get_capabilities</code></td><td>returns runtime limits, search pagination, and degradation contract</td></tr>
        <tr><td><code>memory_store</code></td><td>durable new memory</td></tr>
        <tr><td><code>memory_upsert_messages</code></td><td>atomic upsert of 1–100 keyed messages; insert/update/no-op with required base revision</td></tr>
        <tr><td><code>memory_append</code></td><td>extend a conversation, optimistic revision check</td></tr>
        <tr><td><code>memory_replace</code></td><td>replace its transcript, optimistic revision check</td></tr>
        <tr><td><code>memory_commit_batch</code></td><td>atomically append/replace 1–20 conversations with explicit base revisions</td></tr>
        <tr><td><code>memory_edit_messages</code></td><td>edit known message text (replace/append/prepend), revision-pinned and atomic</td></tr>
        <tr><td><code>memory_restore_revision</code></td><td>restore historical revision, optimistic revision check</td></tr>
        <tr><td><code>memory_copy_conversations</code></td><td>lossless copy into another owned namespace</td></tr>
        <tr><td><code>memory_update_tags</code></td><td>change tags</td></tr>
        <tr><td><code>memory_delete_conversations</code></td><td>delete specific memories (confirmed)</td></tr>
        <tr><td><code>memory_empty_namespace</code></td><td>empty one namespace (exact confirmation)</td></tr>
      </tbody>
    </table>
    <p><code>memory_upsert_messages</code> writes 1–100 unique keyed text messages for one owned conversation and requires an exact current <code>base_revision_id</code>. Keys are 1–128 lowercase ASCII characters matching <code>[a-z0-9._/-]</code>, beginning and ending with a letter or digit. Existing keys replace text while preserving identity, role, creation time, graph, and metadata; role changes are rejected. Missing keys append after the active node in request order. Validate all entries before one atomic revision: all-unchanged requests return <code>no_change</code> without a revision or index job, while mixed inserts and updates commit once. <code>verify: true</code> reloads the committed canonical revision and reports bounded per-key receipt/readback status.</p>
    <p><code>memory_get_messages</code> is annotated <code>readOnlyHint: true</code> and <code>destructiveHint: false</code>. Send 1–100 ordered selectors, each with a <code>conversation_id</code>, optional <code>revision_id</code>, and exactly one of <code>source_node_id</code> (up to 200 characters) or forward-compatible <code>message_key</code> (issue #7's 1–128-character lowercase ASCII key). For example: <code>{ "conversation_id": "…", "source_node_id": "node-42" }</code>. Omitted revisions pin the current head before any R2 load; canonical loads are deduplicated by pinned revision, and duplicate selectors keep their ordered duplicate results. The read uses canonical data only, never FTS or Vectorize.</p>
    <p>Use exactly one of <code>requests</code> (first call) or an opaque, HMAC-signed, tenant-bound <code>cursor</code> (continuation), with an optional 4,096–49,152-byte serialized budget (32,768 default). Results use snake_case envelope fields, admit whole messages only, and return bounded identity/byte diagnostics without text when a message is oversized. Missing, foreign, deleted, or unknown conversations, revisions, nodes, and keys share a uniform <code>NOT_FOUND</code> result. Duplicate canonical message keys return a bounded canonical-storage error and are never resolved by choosing one. The optional key selector reads the <code>messageKey</code> fields created by <code>memory_upsert_messages</code> (and other canonical keyed data); keyed writes are shipped.</p>
    <p><code>memory_get_conversations</code> accepts exactly one of <code>requests</code> (the first call) or an opaque <code>cursor</code> (continuations), plus optional <code>max_serialized_bytes</code>: default 32,768, minimum 4,096, maximum 49,152. Responses report <code>batchId</code>, ordered <code>results</code>, <code>completed</code>, <code>remaining</code>, <code>nextCursor</code>, <code>usedSerializedBytes</code>, and <code>maxSerializedBytes</code>; UTF-8 JSON stays within the requested budget and the 49,152-byte ceiling. Current revisions are pinned before bodies load, so cursor pages never mix concurrent writes; individual errors remain isolated and whole compact messages are admitted in deterministic round-robin order. Loop with <code>{ cursor: … }</code> until <code>nextCursor</code> is absent.</p>
    <p><code>memory_search</code> accepts <code>query</code>, namespace and tag filters, <code>limit</code>, and optional <code>max_serialized_bytes</code> on the first call. If more results remain, continue with only an opaque <code>cursor</code> plus page and byte limits; the tenant-bound snapshot pins the ranking version, order, scores, and revision references. Compact references stay within the requested UTF-8 JSON budget. Snapshots expire automatically; deleted or no-longer-owned candidates are omitted with bounded safe reasons, and preserved <code>degraded</code>/<code>unavailable</code> diagnostics explain retrieval failures. Continuations cannot change the original filters.</p>
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
    <p>Hybrid retrieval combines lexical FTS, semantic vector search, and a bounded recent-canonical fallback for unindexed writes. Namespace and tag filters apply before ranked results are exposed; stable opaque snapshots preserve ranking across pages, while degraded channels remain visible instead of silently returning partial results.</p>
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
    <p>Channel results are merged by deterministic chunk identity, then every candidate is verified against the caller's <code>(user_id, namespace)</code> scope before ranking. The final score combines lexical position, semantic similarity, and recency evidence; <code>memory_search</code> can return compact, revision-pinned references through a tenant-bound opaque snapshot. Expired snapshots and no-longer-owned candidates are handled safely, and channel failure remains visible as degraded.</p>
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
  const sizeLimits = interpolate(messages(locale).limits.sizeLimits, {
    jsonwrite: formatBytes(MAX_INLINE_JSON_WRITE_BYTES),
    directimport: formatBytes(MAX_DIRECT_IMPORT_BYTES),
    multipartpart: formatBytes(MAX_MULTIPART_PART_BYTES),
    tooloutput: formatBytes(MAX_TOOL_OUTPUT_BYTES),
    recommendedoutput: formatBytes(RECOMMENDED_TOOL_OUTPUT_BYTES),
  });
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
      <li>${sizeLimits}</li>
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

function privacyPage(locale: Locale = "en"): Response {
  const body = `
  <p class="eyebrow">PRIVACY</p>
  <h1>Privacy</h1>
  <p class="lead">MemPersist is explicit by design: it stores conversation memory when you or your client asks it to, not by automatically intercepting chats.</p>

  <section>
    <h2>Data categories</h2>
    <ul>
      <li><strong>Account data.</strong> The email address used for passwordless access, an internal account identifier, and the namespaces owned by that account.</li>
      <li><strong>Memory data.</strong> Conversation titles, messages, tags, revisions, source metadata, exports, and ChatGPT imports that you intentionally store or import.</li>
      <li><strong>Authentication data.</strong> Hashes of magic links, dashboard sessions, OAuth codes and tokens, plus the grant and PKCE state needed to authenticate a client. Magic links are single-use and valid for 15 minutes; dashboard sessions last 30 days; OAuth access and refresh tokens use provider defaults of one hour and 30 days.</li>
      <li><strong>Operational data.</strong> Structured event names, request and job identifiers, paths, and error categories. Cloudflare Workers Logs retain these logs for at most seven days under current documented limits; plan and sampling settings control availability. Logs do not contain conversation bodies, search queries, tokens, or authorization headers.</li>
      <li><strong>Derived data.</strong> D1 catalog records, chunks, full-text rows, and vector embeddings used for retrieval. Derived indexes are retained only while needed for retrieval, remain account-scoped, and may be deleted or rebuilt at any time.</li>
    </ul>
  </section>

  <section>
    <h2>Purposes</h2>
    <p>MemPersist uses these categories to authenticate clients, reconnect an account, enforce account and namespace isolation, store and retrieve intentional memory, import and export archives, build search indexes, deliver bounded tool responses, protect the service, and investigate operational failures. It does not infer or invent missing memory, and it does not automatically capture full chats.</p>
  </section>

  <section>
    <h2>Processors and recipients</h2>
    <p>MemPersist runs on Cloudflare Workers and uses Cloudflare R2 for private canonical objects, D1 for the catalog and operational data, KV for OAuth state and grants, Vectorize and Workers AI for derived semantic search, Queues for import and indexing jobs, and Cloudflare Email Service for magic links. Cloudflare's official Workers OAuth provider handles OAuth protocol operations and stores token and code hashes in private KV.</p>
    <p>Your connected MCP client receives only the tool results requested through your authenticated connection. Your email is used for access and is not shared with the client. MemPersist does not publish a public storage bucket or anonymous upload endpoint.</p>
  </section>

  <section>
    <h2>Retention</h2>
    <p>Canonical conversation revisions and raw imports remain in private storage while the account or namespace retains them. Raw ChatGPT import archives are intentionally retained when conversations are deleted. Derived chunks, full-text rows, and vectors are disposable and may be deleted and rebuilt. A conversation deletion is complete only after canonical R2 keys are deleted and D1 cleanup commits.</p>
    <p>Scheduling account deletion starts a seven-day grace period. During that period, reads, export, logout, and cancellation remain available, while writes return <code>DELETION_PENDING</code>. Account deletion revokes grants and erases the account data when the deletion job completes.</p>
  </section>

  <section>
    <h2>Controls</h2>
    <p>Use the authenticated MCP tools or dashboard to search, retrieve, export, update, or delete your own data. Disconnect a client or revoke its OAuth grants when you no longer trust it. Delete conversations only after explicit confirmation; emptying a namespace requires its exact confirmation pair. Schedule account deletion from the dashboard and cancel it during the grace period. Report security issues privately through <a href="https://github.com/ravhirizaldi/mempersist/security/advisories/new">GitHub Security Advisories</a>.</p>
  </section>

  <section>
    <h2>Contact</h2>
    <p>For privacy questions or account support, open an issue at <a href="https://github.com/ravhirizaldi/mempersist/issues">github.com/ravhirizaldi/mempersist/issues</a>. Do not include conversation content, tokens, credentials, or raw logs.</p>
  </section>`;
  return respond(page("Privacy", body, "/privacy", locale), locale);
}

function termsPage(locale: Locale = "en"): Response {
  const body = `
  <p class="eyebrow">TERMS</p>
  <h1>Terms</h1>
  <p class="lead">These terms describe the current MemPersist service behavior for public pages, the dashboard, and the authenticated remote MCP endpoint.</p>

  <section>
    <h2>Service scope</h2>
    <p>MemPersist provides a remote Streamable HTTP MCP server for searching, retrieving, compiling, importing, exporting, and intentionally writing conversation memory. The primary endpoint is <code>${escapeHtml(MCP_ENDPOINT)}</code>. OAuth 2.1 with PKCE and passwordless email links authenticate interactive clients; developer clients may use the owner API token. The single V1 scope is <code>memory</code>.</p>
  </section>

  <section>
    <h2>Account responsibility</h2>
    <p>Keep control of the email inbox used for your archive, connected clients, OAuth grants, and any developer token. Possession of the connected inbox can reconnect to its archive. Use only content and namespaces that you are authorized to store, import, retrieve, or delete. Every request is scoped to the authenticated account; a client cannot select another account's namespace or conversation.</p>
  </section>

  <section>
    <h2>Acceptable use</h2>
    <p>Use MemPersist for your own authorized memory workflows. Do not access another person's archive, use leaked credentials, bypass authentication or ownership checks, submit malicious or oversized imports, extract secrets, degrade the service, or destroy data without the required confirmation. Do not put <code>MEMORY_API_TOKEN</code> into a connector or app configuration; it is for developer API and CLI use.</p>
  </section>

  <section>
    <h2>Writes and deletions</h2>
    <p>Memory enters through explicit MCP writes or an explicit ChatGPT export import; MemPersist does not automatically intercept full chats. Follow the intended <strong>search → select → get context</strong> pattern and verify source and revision identifiers before continuing. Canonical writes are durable before indexing is queued, and a new revision preserves immutable history. Use the complete transcript with <code>memory_replace</code> when replacing, an explicit base revision for revision-safe mutations, and the returned receipts to verify results.</p>
    <p>Destructive tools operate only on your owned conversations or namespaces. <code>memory_delete_conversations</code> deletes selected memories, while <code>memory_empty_namespace</code> requires an exact namespace confirmation and runs in bounded batches. Account deletion has a seven-day grace period; pending account deletion blocks writes while reads, export, logout, and cancellation remain available.</p>
  </section>

  <section>
    <h2>Availability and limitations</h2>
    <p>MemPersist provides no promise of uninterrupted availability or continuously current derived indexes. Imports and indexing run through queued, retryable work; search may report <code>degraded</code> or <code>unavailable</code> channels. A canonical write can remain durable when indexing or verification fails. Cloudflare platform services and third-party MCP clients are outside the application's security document, and client behavior can affect your connection.</p>
  </section>

  <section>
    <h2>Contact</h2>
    <p>For service questions or account support, open an issue at <a href="https://github.com/ravhirizaldi/mempersist/issues">github.com/ravhirizaldi/mempersist/issues</a>. Report vulnerabilities through <a href="https://github.com/ravhirizaldi/mempersist/security/advisories/new">GitHub Security Advisories</a>, without including real conversation content, tokens, credentials, or raw logs.</p>
  </section>`;
  return respond(page("Terms", body, "/terms", locale), locale);
}

function adrsPage(locale: Locale = "en"): Response {
  const adrs: Array<[string, string]> = [
    ["0001", "Clean-room memory platform"],
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
    ["0032", "Deterministic context compilation and pinning"],
    ["0033", "Pointer-aware deterministic expansion"],
    ["0034", "Deterministic pointer follow expansion"],
    ["0035", "Cursor-driven batch conversation pagination"],
    ["0036", "Bounded mutation receipts"],
    ["0037", "Runtime capabilities and aggregate byte budgets"],
    ["0038", "Message-edit provenance"],
    ["0039", "Tenant-bound memory-search snapshots and opaque cursors"],
    ["0040", "Atomic multi-conversation commits"],
    ["0041", "Exact revision-pinned message lookup"],
    ["0042", "Stable keyed message upserts"],
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
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "cross-origin-opener-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com; manifest-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
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
  "/privacy": privacyPage,
  "/terms": termsPage,
  "/adrs": adrsPage,
  "/about": aboutPage,
};
