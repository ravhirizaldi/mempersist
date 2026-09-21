export const PUBLIC_ORIGIN = "https://mempersist.codifiedtech.id";

export const PUBLIC_PATHS = [
  "/",
  "/whitepaper",
  "/architecture",
  "/security",
  "/adrs",
  "/about",
] as const;

const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

function textResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Cache-Control": CACHE_CONTROL,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function robotsResponse(): Response {
  return textResponse(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /api/",
      "Disallow: /authorize",
      "Disallow: /auth/",
      "Disallow: /dashboard",
      "Disallow: /language/",
      "Disallow: /login",
      "Disallow: /mcp",
      "Disallow: /oauth/",
      "Disallow: /readyz",
      "Disallow: /healthz",
      `Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`,
      "",
    ].join("\n"),
    "text/plain; charset=UTF-8",
  );
}

export function sitemapResponse(): Response {
  const urls = PUBLIC_PATHS.map((path) => `  <url><loc>${PUBLIC_ORIGIN}${path}</loc></url>`).join(
    "\n",
  );
  return textResponse(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    "application/xml; charset=UTF-8",
  );
}

export function securityTxtResponse(): Response {
  return textResponse(
    [
      "Contact: https://github.com/ravhirizaldi/mempersist/security/advisories/new",
      `Policy: ${PUBLIC_ORIGIN}/security`,
      `Canonical: ${PUBLIC_ORIGIN}/.well-known/security.txt`,
      "Preferred-Languages: en, id",
      "Expires: 2027-09-21T00:00:00.000Z",
      "",
    ].join("\n"),
    "text/plain; charset=UTF-8",
  );
}

export function manifestResponse(): Response {
  return textResponse(
    JSON.stringify({
      name: "MemPersist",
      short_name: "MemPersist",
      start_url: "/",
      display: "standalone",
      background_color: "#f7f6f2",
      theme_color: "#42634a",
      description: "Durable AI conversation memory for ChatGPT and coding agents.",
    }),
    "application/manifest+json; charset=UTF-8",
  );
}
