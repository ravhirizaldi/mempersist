import type { MindmapClientConversation } from "./types";

export function formatMindmapDate(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "";
  return parsed.toLocaleDateString();
}

/**
 * Renders conversation details into the panel tooltip. Uses `textContent` only so stored
 * titles, tags, and namespaces are never interpreted as markup.
 */
export function showMindmapTooltip(
  tooltip: HTMLElement,
  viewport: HTMLElement,
  item: MindmapClientConversation,
  x: number,
  y: number,
): void {
  tooltip.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = item.title;
  tooltip.append(title);
  const date = formatMindmapDate(item.updated_at);
  if (date) {
    const meta = document.createElement("span");
    meta.textContent = `${date} · ${item.namespace}`;
    tooltip.append(meta);
  }
  if (item.tags.length > 0) {
    const tags = document.createElement("span");
    tags.textContent = `# ${item.tags.slice(0, 4).join(", ")}`;
    tooltip.append(tags);
  }
  const panel = viewport.getBoundingClientRect();
  const offsetX = x - panel.left + 18;
  const offsetY = y - panel.top - 12;
  tooltip.style.left = `${String(Math.min(Math.max(panel.width - 248, 8), Math.max(8, offsetX)))}px`;
  tooltip.style.top = `${String(Math.max(8, offsetY))}px`;
  tooltip.hidden = false;
}

export function hideMindmapTooltip(tooltip: HTMLElement): void {
  tooltip.hidden = true;
}
