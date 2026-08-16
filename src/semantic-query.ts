// Deterministic query-side semantic representations.
//
// The embedding channel uses the raw query unchanged (lexical normalization is
// never applied to embedding input). For long or multilingual paraphrases, a
// second representation appends canonical concept labels detected in the query
// (wallpaper/lock-screen, picture/photo, couple/dating, ...) so the embedding
// is anchored on the query's real intent instead of being diluted by generic
// function words. Both representations are embedded in one batched call and
// their Vectorize candidates are unioned with per-chunk max scores, so a
// chunk returned by several representations never receives repeated credit.

export interface SemanticConcept {
  name: string;
  phrases: string[];
  label: string;
}

export const SEMANTIC_CONCEPTS: SemanticConcept[] = [
  {
    name: "phone-background",
    phrases: [
      "wallpaper",
      "lock screen",
      "phone background",
      "screen background",
      "background hp",
      "latar layar",
      "background layar",
      "layar kunci",
    ],
    label: "wallpaper lock screen phone background",
  },
  {
    name: "picture",
    phrases: ["picture", "photo", "image", "photograph", "foto", "gambar"],
    label: "picture photo image",
  },
  {
    name: "relationship",
    phrases: [
      "started dating",
      "became a couple",
      "become a couple",
      "became official",
      "newly official",
      "official relationship",
      "jadian",
      "mulai pacaran",
      "resmi pacaran",
      "pacaran",
    ],
    label: "couple started dating official relationship",
  },
  {
    name: "responsibility",
    phrases: ["pic", "person in charge", "responsible", "responsibility", "owner", "operator"],
    label: "person in charge responsible",
  },
  {
    name: "packet-loss",
    phrases: ["packet loss", "lost packet", "dropped packet", "packet drop"],
    label: "packet loss dropped packets",
  },
  {
    name: "network-outage",
    phrases: [
      "wan outage",
      "internet failure",
      "internet outage",
      "connection outage",
      "network failure",
      "network outage",
    ],
    label: "network outage internet failure",
  },
  {
    name: "redundancy",
    phrases: ["backup", "secondary", "fallback", "standby"],
    label: "backup redundancy fallback",
  },
  {
    name: "maintenance-window",
    phrases: ["maintenance window", "maintenance schedule", "service window", "service schedule"],
    label: "maintenance window",
  },
  {
    name: "network-edge",
    phrases: ["gateway", "edge gateway", "router", "device", "appliance"],
    label: "network gateway router device",
  },
  {
    name: "connection",
    phrases: ["link", "connection", "connectivity"],
    label: "network link connection",
  },
];

// Bound the appended anchor so semantic retrieval stays cheap and focused.
export const SEMANTIC_QUERY_MAX_ANCHOR_TOKENS = 24;
export const SEMANTIC_QUERY_MAX_VARIANTS = 2;

function queryTokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

export function queryConcepts(query: string): SemanticConcept[] {
  const tokens = queryTokens(query);
  return SEMANTIC_CONCEPTS.filter((concept) =>
    concept.phrases.some((phrase) => [...queryTokens(phrase)].every((token) => tokens.has(token))),
  );
}

export function semanticQueryVariants(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const concepts = queryConcepts(trimmed);
  if (!concepts.length) return [trimmed];
  const queryTokenSet = queryTokens(trimmed);
  const labels: string[] = [];
  for (const concept of concepts) {
    // Keep each canonical label intact as a phrase; drop only labels whose
    // every token is already present in the query, so the anchor never
    // duplicates the query verbatim but always keeps phrase structure.
    const labelTokens = queryTokens(concept.label);
    if ([...labelTokens].every((token) => queryTokenSet.has(token))) continue;
    labels.push(concept.label);
  }
  if (!labels.length) return [trimmed];
  let anchorTokens = 0;
  const bounded: string[] = [];
  for (const label of labels) {
    if (anchorTokens + queryTokens(label).size > SEMANTIC_QUERY_MAX_ANCHOR_TOKENS) break;
    bounded.push(label);
    anchorTokens += queryTokens(label).size;
  }
  if (!bounded.length) return [trimmed];
  const variants = [trimmed, `${trimmed} ${bounded.join(" ")}`];
  return variants.slice(0, SEMANTIC_QUERY_MAX_VARIANTS);
}
