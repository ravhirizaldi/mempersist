import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sourceDir = join(root, "web/mindmap");
const watched = ["client.ts", "graph.ts", "tooltip.ts", "types.ts"];

/**
 * Must match scripts/build-mindmap.ts. The digest proves the checked-in bundle was rebuilt
 * from the current web/mindmap sources.
 */
export function mindmapSourceFingerprint(): string {
  const joined = watched
    .map((name) => readFileSync(join(sourceDir, name), "utf8"))
    .join("\n/* mempersist-mindmap-source */\n");
  return createHash("sha256").update(joined).digest("hex");
}
