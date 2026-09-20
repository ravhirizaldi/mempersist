import { domainId, stableJson } from "./crypto";
import {
  normalizeTags,
  type AppEnv,
  type CanonicalConversation,
  type CanonicalNode,
  type CanonicalRevisionManifest,
} from "./domain";
import { AppError } from "./errors";
import { estimateTokens } from "./chunking";
import { jsonBytes } from "./retrieval";
import {
  loadCanonicalRevision,
  resolveConversations,
  type ConversationResolveResultItem,
} from "./storage";
import { searchMemory } from "./search";
import { scopeNamespaces, type Tenant } from "./tenant";

export const BUILDER_VERSION = "mempersist-context-pack-v1";
export const ESTIMATOR_VERSION = "mempersist-token-estimate-v1";
export const MAX_SERIALIZED_BYTES_LIMIT = 49152;
const MAX_CONTEXT_WARNINGS = 20;

export interface BuildContextRequiredSelector {
  conversation_id?: string;
  title?: string;
  namespace?: string;
  tags?: string[];
  tag_mode?: "any" | "all";
}

export interface BuildContextRequiredItem {
  selector: BuildContextRequiredSelector;
  mode: "full" | "tail";
  branch: "active" | "all";
  priority: number;
  tail_messages?: number;
}

export interface BuildContextRetrieveItem {
  query: string;
  namespace?: string;
  tags?: string[];
  tag_mode?: "any" | "all";
  limit: number;
  context_before: number;
  context_after: number;
  priority: number;
}

export interface BuildContextBudget {
  max_estimated_tokens: number;
  max_serialized_bytes: number;
}

export interface BuildContextOptions {
  deduplicate?: boolean;
  include_provenance?: boolean;
  include_compiled_text?: boolean;
}

export interface BuildContextInput {
  namespace?: string;
  task: string;
  required: BuildContextRequiredItem[];
  retrieve?: BuildContextRetrieveItem[];
  budget: BuildContextBudget;
  options?: BuildContextOptions;
}

export interface ContextRevisionPin {
  conversation_id: string;
  revision_id: string;
  title: string;
  namespace: string;
}

export interface ContextMessageProvenance {
  kind: "required" | "retrieved";
  request_index: number;
  conversation_id: string;
  revision_id: string;
  source_node_id: string;
  chunk_ids?: string[];
  score?: number;
  sources?: Array<"lexical" | "semantic" | "recent_canonical">;
}

export interface ContextMessage {
  source_node_id: string;
  role: string | null;
  created_at: string | null;
  updated_at: string | null;
  text: string;
  conversation_id: string;
  revision_id: string;
  provenance?: ContextMessageProvenance;
}

export interface MatchedRange {
  source_node_id: string;
  char_start: number;
  char_end: number;
}

export interface ContextSection {
  kind: "required" | "retrieved";
  request_index: number;
  title: string;
  priority: number;
  conversation_id: string;
  revision_id: string;
  messages: ContextMessage[];
  estimated_tokens: number;
  serialized_bytes: number;
  matched_chunk_ids?: string[];
  matched_ranges?: MatchedRange[];
}

export interface ContextBudgetUsage {
  max_estimated_tokens: number;
  used_estimated_tokens: number;
  max_serialized_bytes: number;
  used_serialized_bytes: number;
  estimator: "mempersist-token-estimate-v1";
}

export interface ContextOmission {
  kind: "retrieved";
  conversation_id: string;
  revision_id: string;
  reason: "budget" | "stale_revision" | "unavailable";
}

export interface ContextWarning {
  code: string;
  conversation_id?: string;
  revision_id?: string;
  source_node_id?: string;
  bytes?: number;
  message?: string;
}

export interface ContextPackComplete {
  status: "complete";
  pack_id: string;
  namespace: string | null;
  task: string;
  revision_pins: ContextRevisionPin[];
  sections: ContextSection[];
  budget: ContextBudgetUsage;
  omitted: ContextOmission[];
  degraded: boolean;
  unavailable: string[];
  warnings: ContextWarning[];
  compiled_text?: string;
}

export interface ContextPackRequiredBudgetExceeded {
  status: "required_budget_exceeded";
  required_estimated_tokens: number;
  required_serialized_bytes: number;
  suggested_minimum: {
    max_estimated_tokens: number;
    max_serialized_bytes: number;
  };
  warnings: ContextWarning[];
  pack_id?: string;
  degraded: boolean;
  unavailable: string[];
}

export type ContextPack = ContextPackComplete | ContextPackRequiredBudgetExceeded;

interface PinnedResolvedItem {
  requestIndex: number;
  conversationId: string;
  revisionId: string;
  title: string;
  namespace: string;
  mode: "full" | "tail";
  branch: "active" | "all";
  priority: number;
  tailMessages: number;
}

interface ChunkSourceRow {
  revision_id: string;
  current_revision_id: string | null;
  namespace: string;
  title: string;
  source_node_id: string;
  source_sequence: number | null;
  char_start: number;
  char_end: number;
  ordinal: number;
}

interface RetrievedCandidate {
  request_index: number;
  title: string;
  priority: number;
  score: number;
  chunkId: string;
  conversation_id: string;
  revision_id: string;
  rawMessages: CanonicalNode[];
  matched_ranges: MatchedRange[];
  sources: Array<"lexical" | "semantic" | "recent_canonical">;
}

function resolveItemNamespaces(
  tenant: Tenant,
  topLevelNamespace: string | undefined,
  itemNamespace: string | undefined,
): string[] {
  if (itemNamespace) {
    if (!tenant.namespaces.includes(itemNamespace)) {
      throw new AppError("AUTHENTICATION", "Namespace is not accessible to this account", 403);
    }
    if (topLevelNamespace && itemNamespace !== topLevelNamespace) {
      throw new AppError("AUTHENTICATION", "Namespace is not accessible to this account", 403);
    }
    return [itemNamespace];
  }
  if (topLevelNamespace) {
    return [topLevelNamespace];
  }
  return tenant.namespaces;
}

function validateInput(tenant: Tenant, input: BuildContextInput): void {
  if (!input || typeof input !== "object") {
    throw new AppError("VALIDATION", "Input must be an object", 400);
  }
  if (typeof input.task !== "string" || !input.task.trim()) {
    throw new AppError("VALIDATION", "task is required", 400);
  }
  if (!Array.isArray(input.required) || input.required.length < 1 || input.required.length > 20) {
    throw new AppError("VALIDATION", "required must contain 1-20 entries", 400);
  }

  // Validate top-level namespace if provided
  if (input.namespace !== undefined) {
    scopeNamespaces(tenant, input.namespace);
  }

  for (let i = 0; i < input.required.length; i++) {
    const item = input.required[i];
    if (!item || typeof item !== "object") {
      throw new AppError("VALIDATION", `required[${i}] must be an object`, 400);
    }
    if (!item.selector || typeof item.selector !== "object") {
      throw new AppError("VALIDATION", `required[${i}].selector is required`, 400);
    }

    const hasId =
      typeof item.selector.conversation_id === "string" &&
      item.selector.conversation_id.trim().length > 0;
    const hasTitle =
      typeof item.selector.title === "string" && item.selector.title.trim().length > 0;

    if ((hasId && hasTitle) || (!hasId && !hasTitle)) {
      throw new AppError(
        "VALIDATION",
        `required[${i}].selector must contain exactly one of conversation_id or title`,
        400,
      );
    }

    if (
      item.selector.tag_mode !== undefined &&
      item.selector.tag_mode !== "any" &&
      item.selector.tag_mode !== "all"
    ) {
      throw new AppError(
        "VALIDATION",
        `required[${i}].selector.tag_mode must be "any" or "all"`,
        400,
      );
    }

    if (item.selector.namespace !== undefined) {
      resolveItemNamespaces(tenant, input.namespace, item.selector.namespace);
    }

    if (item.mode !== "full" && item.mode !== "tail") {
      throw new AppError("VALIDATION", `required[${i}].mode must be "full" or "tail"`, 400);
    }
    if (item.branch !== "active" && item.branch !== "all") {
      throw new AppError("VALIDATION", `required[${i}].branch must be "active" or "all"`, 400);
    }
    if (typeof item.priority !== "number" || !Number.isFinite(item.priority)) {
      throw new AppError("VALIDATION", `required[${i}].priority must be a finite number`, 400);
    }
    if (item.tail_messages !== undefined) {
      if (
        typeof item.tail_messages !== "number" ||
        !Number.isInteger(item.tail_messages) ||
        item.tail_messages < 1 ||
        item.tail_messages > 100
      ) {
        throw new AppError(
          "VALIDATION",
          `required[${i}].tail_messages must be an integer between 1 and 100`,
          400,
        );
      }
    }
  }

  if (input.retrieve !== undefined) {
    if (!Array.isArray(input.retrieve)) {
      throw new AppError("VALIDATION", "retrieve must be an array", 400);
    }
    if (input.retrieve.length > 8) {
      throw new AppError("VALIDATION", "retrieve must not exceed 8 entries", 400);
    }
    for (let i = 0; i < input.retrieve.length; i++) {
      const ret = input.retrieve[i];
      if (!ret || typeof ret !== "object") {
        throw new AppError("VALIDATION", `retrieve[${i}] must be an object`, 400);
      }
      if (typeof ret.query !== "string" || !ret.query.trim()) {
        throw new AppError("VALIDATION", `retrieve[${i}].query must be a non-empty string`, 400);
      }
      if (typeof ret.priority !== "number" || !Number.isFinite(ret.priority)) {
        throw new AppError("VALIDATION", `retrieve[${i}].priority must be a finite number`, 400);
      }
      if (ret.namespace !== undefined) {
        resolveItemNamespaces(tenant, input.namespace, ret.namespace);
      }
      if (ret.tag_mode !== undefined && ret.tag_mode !== "any" && ret.tag_mode !== "all") {
        throw new AppError("VALIDATION", `retrieve[${i}].tag_mode must be "any" or "all"`, 400);
      }
    }
  }

  if (!input.budget || typeof input.budget !== "object") {
    throw new AppError("VALIDATION", "budget is required", 400);
  }
  if (
    typeof input.budget.max_estimated_tokens !== "number" ||
    !Number.isFinite(input.budget.max_estimated_tokens) ||
    input.budget.max_estimated_tokens < 1
  ) {
    throw new AppError("VALIDATION", "budget.max_estimated_tokens must be a positive number", 400);
  }
  if (
    typeof input.budget.max_serialized_bytes !== "number" ||
    !Number.isFinite(input.budget.max_serialized_bytes) ||
    input.budget.max_serialized_bytes < 1
  ) {
    throw new AppError("VALIDATION", "budget.max_serialized_bytes must be a positive number", 400);
  }
  if (input.budget.max_serialized_bytes > MAX_SERIALIZED_BYTES_LIMIT) {
    throw new AppError(
      "VALIDATION",
      `budget.max_serialized_bytes must not exceed ${MAX_SERIALIZED_BYTES_LIMIT}`,
      400,
    );
  }
}

interface StagedEvidenceItem {
  section: ContextSection;
  prevMatchedChunkIds: string[] | undefined;
  prevMatchedRanges: MatchedRange[] | undefined;
  prevSerializedBytes: number;
  message: ContextMessage;
  prevProvenance: ContextMessageProvenance | undefined;
}

function rollbackStagedEvidence(staged: StagedEvidenceItem[]): void {
  for (const item of staged) {
    if (item.prevMatchedChunkIds !== undefined) {
      item.section.matched_chunk_ids = item.prevMatchedChunkIds;
    } else {
      delete item.section.matched_chunk_ids;
    }
    if (item.prevMatchedRanges !== undefined) {
      item.section.matched_ranges = item.prevMatchedRanges;
    } else {
      delete item.section.matched_ranges;
    }
    item.section.serialized_bytes = item.prevSerializedBytes;
    if (item.prevProvenance !== undefined) {
      item.message.provenance = item.prevProvenance;
    } else {
      delete item.message.provenance;
    }
  }
}
function cloneProvenance(provenance: ContextMessageProvenance): ContextMessageProvenance {
  return {
    kind: provenance.kind,
    request_index: provenance.request_index,
    conversation_id: provenance.conversation_id,
    revision_id: provenance.revision_id,
    source_node_id: provenance.source_node_id,
    ...(provenance.chunk_ids ? { chunk_ids: [...provenance.chunk_ids] } : {}),
    ...(provenance.score !== undefined ? { score: provenance.score } : {}),
    ...(provenance.sources ? { sources: [...provenance.sources] } : {}),
  };
}

interface RequiredMessageBaseline {
  message: ContextMessage;
  provenance?: ContextMessageProvenance;
}

interface RequiredSectionBaseline {
  section: ContextSection;
  matched_chunk_ids?: string[];
  matched_ranges?: MatchedRange[];
  serialized_bytes: number;
  messages: RequiredMessageBaseline[];
}

function restoreRequiredBaselines(baselines: RequiredSectionBaseline[]): void {
  for (const base of baselines) {
    if (base.matched_chunk_ids !== undefined) {
      base.section.matched_chunk_ids = [...base.matched_chunk_ids];
    } else {
      delete base.section.matched_chunk_ids;
    }
    if (base.matched_ranges !== undefined) {
      base.section.matched_ranges = base.matched_ranges.map((r) => ({ ...r }));
    } else {
      delete base.section.matched_ranges;
    }
    for (const mb of base.messages) {
      if (mb.provenance !== undefined) {
        mb.message.provenance = cloneProvenance(mb.provenance);
      } else {
        delete mb.message.provenance;
      }
    }
    base.section.serialized_bytes = jsonBytes(base.section);
  }
}

function buildCompiledText(sections: ContextSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    if (lines.length > 0) {
      lines.push("");
    }
    if (section.kind === "required") {
      lines.push(`[REQUIRED MEMORY: ${section.title}]`);
      lines.push(`conversation_id: ${section.conversation_id}`);
      lines.push(`revision_id: ${section.revision_id}`);
    } else {
      lines.push(`[RETRIEVED EVIDENCE: ${section.title}]`);
      lines.push(`conversation_id: ${section.conversation_id}`);
      lines.push(`revision_id: ${section.revision_id}`);
      if (section.matched_chunk_ids && section.matched_chunk_ids.length > 0) {
        lines.push(`matched_chunk_ids: ${section.matched_chunk_ids.join(", ")}`);
      }
    }
    lines.push("");
    for (let i = 0; i < section.messages.length; i++) {
      if (i > 0) {
        lines.push("");
      }
      const message = section.messages[i];
      if (message) {
        lines.push(message.text);
      }
    }
  }
  return lines.join("\n");
}

async function computePackId(
  env: AppEnv,
  input: BuildContextInput,
  revisionPins: ContextRevisionPin[],
  sections: ContextSection[],
  compiledText?: string,
): Promise<string> {
  const normalizedInput = {
    namespace: input.namespace ?? null,
    task: input.task,
    required: input.required.map((req) => ({
      selector: {
        ...(req.selector.conversation_id ? { conversation_id: req.selector.conversation_id } : {}),
        ...(req.selector.title ? { title: req.selector.title } : {}),
        ...(req.selector.namespace ? { namespace: req.selector.namespace } : {}),
        ...(req.selector.tags ? { tags: normalizeTags(req.selector.tags) } : {}),
        ...(req.selector.tag_mode ? { tag_mode: req.selector.tag_mode } : {}),
      },
      mode: req.mode,
      branch: req.branch,
      priority: req.priority,
      tail_messages: req.tail_messages ?? 20,
    })),
    retrieve: (input.retrieve ?? []).map((ret) => ({
      query: ret.query,
      ...(ret.namespace ? { namespace: ret.namespace } : {}),
      ...(ret.tags ? { tags: normalizeTags(ret.tags) } : {}),
      ...(ret.tag_mode ? { tag_mode: ret.tag_mode } : {}),
      limit: Math.min(20, Math.max(1, Math.floor(ret.limit ?? 8))),
      context_before: Math.min(10, Math.max(0, Math.floor(ret.context_before ?? 2))),
      context_after: Math.min(10, Math.max(0, Math.floor(ret.context_after ?? 2))),
      priority: ret.priority,
    })),
    budget: input.budget,
    options: {
      deduplicate: input.options?.deduplicate ?? true,
      include_provenance: input.options?.include_provenance ?? true,
      include_compiled_text: input.options?.include_compiled_text ?? true,
    },
  };

  return domainId(
    "context-pack",
    BUILDER_VERSION,
    stableJson(normalizedInput),
    stableJson(revisionPins),
    env.ACTIVE_INDEX_GENERATION ?? "",
    stableJson(sections),
    compiledText ?? "",
  );
}

function computePackSerializedBytes(pack: Record<string, unknown>): number {
  const budget = pack.budget as Record<string, unknown>;
  budget.used_serialized_bytes = 0;
  const baseBytes = jsonBytes(pack);
  let n = baseBytes;
  for (let i = 0; i < 10; i++) {
    const nextN = baseBytes - 1 + String(n).length;
    if (nextN === n) {
      break;
    }
    n = nextN;
  }
  budget.used_serialized_bytes = n;
  const actual = jsonBytes(pack);
  if (actual !== n) {
    budget.used_serialized_bytes = actual;
    return actual;
  }
  return n;
}

export async function buildContext(
  env: AppEnv,
  tenant: Tenant,
  input: BuildContextInput,
): Promise<ContextPack> {
  validateInput(tenant, input);

  const deduplicate = input.options?.deduplicate ?? true;
  const includeProvenance = input.options?.include_provenance ?? true;
  const includeCompiledText = input.options?.include_compiled_text ?? true;

  // 1. Resolve and pin all required selectors BEFORE any canonical loading or retrieval
  const resolvedRequired: PinnedResolvedItem[] = new Array<PinnedResolvedItem>(
    input.required.length,
  );

  // Group title selectors for batch resolution
  const titleRequests: Array<{
    itemIndex: number;
    title: string;
    namespaces: string[];
    tags?: string[];
    tagMode?: "any" | "all";
  }> = [];

  for (let i = 0; i < input.required.length; i++) {
    const item = input.required[i];
    if (!item) continue;
    const namespaces = resolveItemNamespaces(tenant, input.namespace, item.selector.namespace);
    if (item.selector.title) {
      titleRequests.push({
        itemIndex: i,
        title: item.selector.title,
        namespaces,
        ...(item.selector.tags !== undefined ? { tags: item.selector.tags } : {}),
        ...(item.selector.tag_mode !== undefined ? { tagMode: item.selector.tag_mode } : {}),
      });
    }
  }

  // Resolve title selectors in batch
  if (titleRequests.length > 0) {
    const resolvedTitles: ConversationResolveResultItem[] = await resolveConversations(
      env,
      tenant.userId,
      titleRequests.map((req) => ({
        title: req.title,
        namespaces: req.namespaces,
        ...(req.tags !== undefined ? { tags: req.tags } : {}),
        ...(req.tagMode !== undefined ? { tagMode: req.tagMode } : {}),
      })),
    );

    for (let j = 0; j < resolvedTitles.length; j++) {
      const res = resolvedTitles[j];
      const meta = titleRequests[j];
      if (!res || !meta) continue;
      const reqItem = input.required[meta.itemIndex];
      if (!reqItem) continue;
      if (res.status === "not_found") {
        throw new AppError("NOT_FOUND", `Required conversation "${meta.title}" not found`, 404);
      }
      if (res.status === "ambiguous") {
        throw new AppError(
          "VALIDATION",
          `Required conversation "${meta.title}" is ambiguous (${res.matches.length} matches)`,
          400,
        );
      }
      const match = res.matches[0];
      if (!match) continue;
      resolvedRequired[meta.itemIndex] = {
        requestIndex: meta.itemIndex,
        conversationId: match.conversationId,
        revisionId: match.revisionId,
        title: match.title,
        namespace: match.namespace,
        mode: reqItem.mode,
        branch: reqItem.branch,
        priority: reqItem.priority,
        tailMessages: reqItem.tail_messages !== undefined ? Math.floor(reqItem.tail_messages) : 20,
      };
    }
  }

  // Resolve ID selectors directly from D1
  const idIndices = input.required
    .map((item, idx) => (item.selector.conversation_id ? idx : -1))
    .filter((idx) => idx >= 0);

  if (idIndices.length > 0) {
    await Promise.all(
      idIndices.map(async (idx) => {
        const item = input.required[idx];
        if (!item) return;
        const convId = item.selector.conversation_id;
        if (!convId) return;

        const namespaces = resolveItemNamespaces(tenant, input.namespace, item.selector.namespace);

        const where = [
          "id = ?",
          "user_id = ?",
          "deleted_at IS NULL",
          "current_revision_id IS NOT NULL",
        ];
        const params: Array<string | number> = [convId, tenant.userId];

        if (namespaces.length === 0) {
          where.push("1 = 0");
        } else {
          where.push(`namespace IN (${namespaces.map(() => "?").join(",")})`);
          params.push(...namespaces);
        }

        const tags = normalizeTags(item.selector.tags ?? []);
        if (tags.length) {
          where.push(
            item.selector.tag_mode === "any"
              ? `id IN (SELECT DISTINCT conversation_id FROM conversation_tags WHERE tag IN (${tags
                  .map(() => "?")
                  .join(",")}))`
              : `id IN (SELECT conversation_id FROM conversation_tags WHERE tag IN (${tags
                  .map(() => "?")
                  .join(",")}) GROUP BY conversation_id HAVING COUNT(*) = ?)`,
          );
          params.push(...tags);
          if (item.selector.tag_mode !== "any") params.push(tags.length);
        }

        const row = await env.MEMORY_DB.prepare(
          `SELECT id, title, namespace, current_revision_id
           FROM conversations
           WHERE ${where.join(" AND ")}
           LIMIT 1`,
        )
          .bind(...params)
          .first<{ id: string; title: string; namespace: string; current_revision_id: string }>();

        if (!row) {
          throw new AppError("NOT_FOUND", `Required conversation "${convId}" not found`, 404);
        }

        resolvedRequired[idx] = {
          requestIndex: idx,
          conversationId: row.id,
          revisionId: row.current_revision_id,
          title: row.title,
          namespace: row.namespace,
          mode: item.mode,
          branch: item.branch,
          priority: item.priority,
          tailMessages: item.tail_messages !== undefined ? Math.floor(item.tail_messages) : 20,
        };
      }),
    );
  }
  // Canonicalize duplicate required selectors for the same conversation_id to one chosen pinned revision
  const canonicalByConv = new Map<string, PinnedResolvedItem>();
  for (const item of resolvedRequired) {
    if (!item) continue;
    const existing = canonicalByConv.get(item.conversationId);
    if (!existing) {
      canonicalByConv.set(item.conversationId, item);
    } else {
      const preferExisting =
        existing.priority > item.priority ||
        (existing.priority === item.priority && existing.requestIndex <= item.requestIndex);
      if (!preferExisting) {
        canonicalByConv.set(item.conversationId, item);
      }
    }
  }

  for (const item of resolvedRequired) {
    if (!item) continue;
    const canonical = canonicalByConv.get(item.conversationId);
    if (canonical && item.revisionId !== canonical.revisionId) {
      item.revisionId = canonical.revisionId;
      item.title = canonical.title;
      item.namespace = canonical.namespace;
    }
  }

  // Populate revision pins (unique by conversation ID)
  const pinMap = new Map<string, ContextRevisionPin>();
  for (const item of resolvedRequired) {
    if (!item) continue;
    if (!pinMap.has(item.conversationId)) {
      pinMap.set(item.conversationId, {
        conversation_id: item.conversationId,
        revision_id: item.revisionId,
        title: item.title,
        namespace: item.namespace,
      });
    }
  }
  const revision_pins = Array.from(pinMap.values());

  // 2. Load pinned canonical revisions in bounded waves of 4
  const uniqueRevisionIds = Array.from(
    new Set(
      resolvedRequired
        .filter((item): item is PinnedResolvedItem => item !== undefined)
        .map((item) => item.revisionId),
    ),
  );
  const revisionCache = new Map<
    string,
    { conversation: CanonicalConversation; manifest: CanonicalRevisionManifest }
  >();

  for (let i = 0; i < uniqueRevisionIds.length; i += 4) {
    const wave = uniqueRevisionIds.slice(i, i + 4);
    const loadedWave = await Promise.all(wave.map((revId) => loadCanonicalRevision(env, revId)));
    for (let j = 0; j < wave.length; j++) {
      const revId = wave[j];
      const loaded = loadedWave[j];
      if (revId && loaded) {
        revisionCache.set(revId, loaded);
      }
    }
  }
  // 3. Extract required messages and construct required sections
  const requiredSections: ContextSection[] = [];
  for (let i = 0; i < resolvedRequired.length; i++) {
    const item = resolvedRequired[i];
    if (!item) continue;
    const loaded = revisionCache.get(item.revisionId);
    if (!loaded) continue;
    const conversation = loaded.conversation;

    let branchNodes: CanonicalNode[];
    if (item.branch === "active") {
      const byId = new Map(conversation.nodes.map((n) => [n.sourceNodeId, n]));
      branchNodes = (conversation.activeSourceNodeIds ?? [])
        .map((id) => byId.get(id))
        .filter((n): n is CanonicalNode => n !== undefined && n.text.length > 0);
    } else {
      branchNodes = (conversation.nodes ?? []).filter((n) => n.text.length > 0);
    }

    let selectedNodes: CanonicalNode[];
    if (item.mode === "full") {
      selectedNodes = branchNodes;
    } else {
      selectedNodes = branchNodes.slice(-item.tailMessages);
    }

    const messages: ContextMessage[] = selectedNodes.map((node) => {
      const msg: ContextMessage = {
        source_node_id: node.sourceNodeId,
        role: node.role ?? null,
        created_at: node.createdAt,
        updated_at: node.updatedAt,
        text: node.text,
        conversation_id: item.conversationId,
        revision_id: item.revisionId,
      };
      if (includeProvenance) {
        msg.provenance = {
          kind: "required",
          request_index: item.requestIndex,
          conversation_id: item.conversationId,
          revision_id: item.revisionId,
          source_node_id: node.sourceNodeId,
        };
      }
      return msg;
    });

    const estimatedTokens = messages.reduce((sum, m) => sum + estimateTokens(m.text), 0);
    const section: ContextSection = {
      kind: "required",
      request_index: item.requestIndex,
      title: item.title,
      priority: item.priority,
      conversation_id: item.conversationId,
      revision_id: item.revisionId,
      messages,
      estimated_tokens: estimatedTokens,
      serialized_bytes: 0,
    };
    section.serialized_bytes = jsonBytes(section);
    requiredSections.push(section);
  }

  // Sort required sections: priority desc, request_index asc
  requiredSections.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.request_index - b.request_index;
  });

  // Track seen messages for deduplication
  const seenMessages = new Map<string, { section: ContextSection; message: ContextMessage }>();

  // If deduplication is enabled, deduplicate across required sections as well
  for (const sec of requiredSections) {
    const retainedMessages: ContextMessage[] = [];
    for (const msg of sec.messages) {
      const key = `${msg.conversation_id}:${msg.revision_id}:${msg.source_node_id}`;
      if (deduplicate && seenMessages.has(key)) {
        continue;
      }
      retainedMessages.push(msg);
      seenMessages.set(key, { section: sec, message: msg });
    }
    sec.messages = retainedMessages;
    sec.estimated_tokens = sec.messages.reduce((sum, m) => sum + estimateTokens(m.text), 0);
    sec.serialized_bytes = jsonBytes(sec);
  }

  // 4. Check if required content alone exceeds budget
  const requiredEstimatedTokens = requiredSections.reduce(
    (sum, sec) => sum + sec.estimated_tokens,
    0,
  );

  const draftRequiredOnly: Record<string, unknown> = {
    status: "complete",
    pack_id: "0".repeat(64),
    namespace: input.namespace ?? null,
    task: input.task,
    revision_pins,
    sections: requiredSections,
    budget: {
      max_estimated_tokens: input.budget.max_estimated_tokens,
      used_estimated_tokens: requiredEstimatedTokens,
      max_serialized_bytes: input.budget.max_serialized_bytes,
      used_serialized_bytes: 0,
      estimator: ESTIMATOR_VERSION,
    },
    omitted: [],
    degraded: false,
    unavailable: [],
    warnings: [],
    ...(includeCompiledText ? { compiled_text: buildCompiledText(requiredSections) } : {}),
  };

  const requiredSerializedBytes = computePackSerializedBytes(draftRequiredOnly);

  if (
    requiredEstimatedTokens > input.budget.max_estimated_tokens ||
    requiredSerializedBytes > input.budget.max_serialized_bytes
  ) {
    const suggestedTokens = Math.max(
      requiredEstimatedTokens,
      Math.ceil((requiredEstimatedTokens * 1.05) / 100) * 100,
    );
    const suggestedBytes = Math.max(
      requiredSerializedBytes,
      Math.ceil((requiredSerializedBytes * 1.05) / 1024) * 1024,
    );

    const exceededWarnings: ContextWarning[] = [];
    if (requiredSerializedBytes > MAX_SERIALIZED_BYTES_LIMIT) {
      exceededWarnings.push({
        code: "REQUIRED_CONTENT_EXCEEDS_MCP_LIMIT",
        bytes: requiredSerializedBytes,
        message: `Required content exceeds maximum MCP limit of ${MAX_SERIALIZED_BYTES_LIMIT} bytes. Narrow required modes or use revision-pinned pagination.`,
      });
    }

    const MAX_OVERSIZED_DIAGNOSTICS = 20;
    let totalOversized = 0;
    let representedOversized = 0;

    for (const sec of requiredSections) {
      for (const msg of sec.messages) {
        const msgBytes = jsonBytes(msg);
        if (msgBytes > input.budget.max_serialized_bytes || msgBytes > MAX_SERIALIZED_BYTES_LIMIT) {
          totalOversized++;
          if (representedOversized < MAX_OVERSIZED_DIAGNOSTICS) {
            representedOversized++;
            exceededWarnings.push({
              code: "OVERSIZED_MESSAGE",
              conversation_id: msg.conversation_id,
              revision_id: msg.revision_id,
              source_node_id: msg.source_node_id,
              bytes: msgBytes,
              message: `Message ${msg.source_node_id} exceeds byte limit (${msgBytes} bytes)`,
            });
          }
        }
      }
    }

    if (totalOversized > representedOversized) {
      exceededWarnings.push({
        code: "DIAGNOSTICS_TRUNCATED",
        message: `${totalOversized - representedOversized} additional oversized messages truncated`,
      });
    }

    const exceededPackId = await computePackId(env, input, revision_pins, [], "");

    return {
      status: "required_budget_exceeded",
      required_estimated_tokens: requiredEstimatedTokens,
      required_serialized_bytes: requiredSerializedBytes,
      suggested_minimum: {
        max_estimated_tokens: suggestedTokens,
        max_serialized_bytes: suggestedBytes,
      },
      warnings: exceededWarnings,
      pack_id: exceededPackId,
      degraded: false,
      unavailable: [],
    };
  }

  // 5. Run retrieval concurrently only after required pins and budget check
  let degraded = false;
  const unavailableSet = new Set<string>();
  const warnings: ContextWarning[] = [];
  let droppedWarningCount = 0;
  function addWarning(warning: ContextWarning): void {
    if (droppedWarningCount > 0) {
      droppedWarningCount++;
      return;
    }
    if (warnings.length < MAX_CONTEXT_WARNINGS) {
      warnings.push(warning);
      return;
    }
    warnings.pop();
    droppedWarningCount = 2;
  }
  function finalizeWarnings(): void {
    if (droppedWarningCount > 0) {
      warnings.push({
        code: "DIAGNOSTICS_TRUNCATED",
        message: `${droppedWarningCount} additional context warnings truncated`,
      });
    }
  }
  function evictWarningDetailForBudget(): boolean {
    const summary = warnings.at(-1);
    if (summary?.code === "DIAGNOSTICS_TRUNCATED") {
      if (warnings.length <= 1) return false;
      warnings.splice(warnings.length - 2, 1);
      droppedWarningCount++;
      summary.message = `${droppedWarningCount} additional context warnings truncated`;
      return true;
    }
    if (warnings.length === 0) return false;
    warnings.pop();
    return true;
  }
  const omitted: ContextOmission[] = [];
  const retrievedCandidates: RetrievedCandidate[] = [];

  if (input.retrieve && input.retrieve.length > 0) {
    const searchTasks = input.retrieve.map(async (retReq, retrieveIndex) => {
      const namespaces = resolveItemNamespaces(tenant, input.namespace, retReq.namespace);
      const limit = Math.min(20, Math.max(1, Math.floor(retReq.limit ?? 8)));
      try {
        const response = await searchMemory(env, {
          query: retReq.query,
          limit,
          namespaces,
          userId: tenant.userId,
          ...(retReq.tags !== undefined ? { tags: retReq.tags } : {}),
          ...(retReq.tag_mode !== undefined ? { tagMode: retReq.tag_mode } : {}),
        });
        return { retrieveIndex, retReq, namespaces, response, error: null };
      } catch (err: unknown) {
        return { retrieveIndex, retReq, namespaces, response: null, error: err };
      }
    });

    const searchResponses = await Promise.all(searchTasks);

    for (const res of searchResponses) {
      if (res.error || !res.response) {
        degraded = true;
        addWarning({
          code: "RETRIEVAL_FAILED",
          message: res.error instanceof Error ? res.error.message : "Search query failed",
        });
        continue;
      }

      if (res.response.degraded) {
        degraded = true;
      }
      for (const un of res.response.unavailable) {
        unavailableSet.add(un);
      }

      // Process each hit returned by search
      for (const hit of res.response.results) {
        // Query D1 for chunk sources and conversation head revision check
        const rowsResult = await env.MEMORY_DB.prepare(
          `SELECT c.revision_id, cv.current_revision_id, c.namespace, c.title, s.source_node_id, s.source_sequence, s.char_start, s.char_end, s.ordinal
           FROM chunks c
           JOIN chunk_sources s ON s.chunk_id = c.id
           JOIN conversations cv ON cv.id = c.conversation_id
           WHERE c.id = ? AND cv.user_id = ? AND cv.deleted_at IS NULL
           ORDER BY s.ordinal`,
        )
          .bind(hit.chunkId, tenant.userId)
          .all<ChunkSourceRow>();

        const rows = rowsResult.results;
        if (!rows || rows.length === 0) {
          omitted.push({
            kind: "retrieved",
            conversation_id: hit.conversationId,
            revision_id: hit.revisionId,
            reason: "unavailable",
          });
          continue;
        }

        const firstRow = rows[0];
        if (!firstRow) {
          omitted.push({
            kind: "retrieved",
            conversation_id: hit.conversationId,
            revision_id: hit.revisionId,
            reason: "unavailable",
          });
          continue;
        }
        // Tenant/namespace access check
        if (!res.namespaces.includes(firstRow.namespace)) {
          omitted.push({
            kind: "retrieved",
            conversation_id: hit.conversationId,
            revision_id: hit.revisionId,
            reason: "unavailable",
          });
          continue;
        }

        // Stale revision check: check both indexed chunk revision and current conversation head
        const pinned = pinMap.get(hit.conversationId);
        const isStale =
          firstRow.revision_id !== hit.revisionId ||
          (firstRow.current_revision_id !== null &&
            firstRow.current_revision_id !== hit.revisionId) ||
          (pinned !== undefined && pinned.revision_id !== hit.revisionId);

        if (isStale) {
          omitted.push({
            kind: "retrieved",
            conversation_id: hit.conversationId,
            revision_id: hit.revisionId,
            reason: "stale_revision",
          });
          addWarning({
            code: "STALE_REVISION",
            conversation_id: hit.conversationId,
            revision_id: hit.revisionId,
            message: `Retrieved revision "${hit.revisionId}" is stale (current head is "${firstRow.current_revision_id}")`,
          });
          continue;
        }

        // Load canonical revision for retrieved chunk (must load the search-returned revision)
        let loadedRev = revisionCache.get(hit.revisionId);
        if (!loadedRev) {
          try {
            loadedRev = await loadCanonicalRevision(env, hit.revisionId);
            revisionCache.set(hit.revisionId, loadedRev);
          } catch (err: unknown) {
            const isNotFound = err instanceof AppError && err.code === "NOT_FOUND";
            omitted.push({
              kind: "retrieved",
              conversation_id: hit.conversationId,
              revision_id: hit.revisionId,
              reason: isNotFound ? "stale_revision" : "unavailable",
            });
            addWarning({
              code: isNotFound ? "STALE_REVISION" : "CONTEXT_LOAD_FAILED",
              conversation_id: hit.conversationId,
              revision_id: hit.revisionId,
              message: err instanceof Error ? err.message : "Failed to load canonical revision",
            });
            continue;
          }
        }

        // Extract messages around chunk sources
        const before = Math.min(10, Math.max(0, Math.floor(res.retReq.context_before ?? 2)));
        const after = Math.min(10, Math.max(0, Math.floor(res.retReq.context_after ?? 2)));
        const byId = new Map(loadedRev.conversation.nodes.map((node) => [node.sourceNodeId, node]));
        const active = loadedRev.conversation.activeSourceNodeIds ?? [];
        const activeSequences = rows.flatMap((source) =>
          source.source_sequence === null ? [] : [source.source_sequence],
        );

        let chunkMessages: CanonicalNode[];
        if (activeSequences.length > 0) {
          const start = Math.max(0, Math.min(...activeSequences) - before);
          const end = Math.min(active.length, Math.max(...activeSequences) + after + 1);
          chunkMessages = active
            .slice(start, end)
            .flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
        } else {
          const ids = new Set<string>();
          for (const source of rows) {
            ids.add(source.source_node_id);
            const node = byId.get(source.source_node_id);
            if (node?.parentSourceNodeId) ids.add(node.parentSourceNodeId);
            node?.childSourceNodeIds?.forEach((id) => ids.add(id));
          }
          chunkMessages = [...ids].flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
        }
        chunkMessages = chunkMessages.filter((node) => node.text.length > 0);

        const matchedRanges: MatchedRange[] = rows.map((r) => ({
          source_node_id: r.source_node_id,
          char_start: r.char_start,
          char_end: r.char_end,
        }));

        retrievedCandidates.push({
          request_index: res.retrieveIndex,
          title: firstRow.title || hit.title || loadedRev.conversation.title,
          priority: res.retReq.priority,
          score: hit.score,
          chunkId: hit.chunkId,
          conversation_id: hit.conversationId,
          revision_id: hit.revisionId,
          rawMessages: chunkMessages,
          matched_ranges: matchedRanges,
          sources: hit.sources,
        });
      }
    }
  }

  // 6. Sort retrieved candidates and greedily fit whole messages
  // Sorting: priority desc, score desc, request_index asc, stable conversation/revision/chunk IDs
  retrievedCandidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.score !== a.score) return b.score - a.score;
    if (a.request_index !== b.request_index) return a.request_index - b.request_index;
    if (a.conversation_id !== b.conversation_id) {
      return a.conversation_id.localeCompare(b.conversation_id);
    }
    if (a.revision_id !== b.revision_id) {
      return a.revision_id.localeCompare(b.revision_id);
    }
    return a.chunkId.localeCompare(b.chunkId);
  });

  const admittedSections: ContextSection[] = [...requiredSections];
  let usedEstimatedTokens = requiredEstimatedTokens;

  const candidateEvidenceMap = new Map<ContextSection, StagedEvidenceItem[]>();
  const admittedEvidenceOnlyCandidates: Array<{
    conversation_id: string;
    revision_id: string;
    stagedEvidence: StagedEvidenceItem[];
  }> = [];

  const requiredBaselines: RequiredSectionBaseline[] = requiredSections.map((sec) => ({
    section: sec,
    ...(sec.matched_chunk_ids ? { matched_chunk_ids: [...sec.matched_chunk_ids] } : {}),
    ...(sec.matched_ranges ? { matched_ranges: sec.matched_ranges.map((r) => ({ ...r })) } : {}),
    serialized_bytes: sec.serialized_bytes,
    messages: sec.messages.map((msg) => ({
      message: msg,
      ...(msg.provenance ? { provenance: cloneProvenance(msg.provenance) } : {}),
    })),
  }));

  for (const candidate of retrievedCandidates) {
    // 6a. Check for oversized messages in optional retrieved candidate
    let hasOversizedMessage = false;
    for (const rawMsg of candidate.rawMessages) {
      const msg: ContextMessage = {
        source_node_id: rawMsg.sourceNodeId,
        role: rawMsg.role ?? null,
        created_at: rawMsg.createdAt,
        updated_at: rawMsg.updatedAt,
        text: rawMsg.text,
        conversation_id: candidate.conversation_id,
        revision_id: candidate.revision_id,
      };
      if (includeProvenance) {
        msg.provenance = {
          kind: "retrieved",
          request_index: candidate.request_index,
          conversation_id: candidate.conversation_id,
          revision_id: candidate.revision_id,
          source_node_id: rawMsg.sourceNodeId,
          chunk_ids: [candidate.chunkId],
          score: candidate.score,
          sources: candidate.sources,
        };
      }
      const msgBytes = jsonBytes(msg);
      if (msgBytes > input.budget.max_serialized_bytes || msgBytes > MAX_SERIALIZED_BYTES_LIMIT) {
        hasOversizedMessage = true;
        addWarning({
          code: "OVERSIZED_MESSAGE",
          conversation_id: candidate.conversation_id,
          revision_id: candidate.revision_id,
          source_node_id: rawMsg.sourceNodeId,
          bytes: msgBytes,
          message: `Message ${rawMsg.sourceNodeId} exceeds byte limit (${msgBytes} bytes)`,
        });
      }
    }

    if (hasOversizedMessage) {
      omitted.push({
        kind: "retrieved",
        conversation_id: candidate.conversation_id,
        revision_id: candidate.revision_id,
        reason: "budget",
      });
      continue;
    }

    const candidateMessages: ContextMessage[] = [];
    const stagedEvidence: StagedEvidenceItem[] = [];

    for (const rawMsg of candidate.rawMessages) {
      const key = `${candidate.conversation_id}:${candidate.revision_id}:${rawMsg.sourceNodeId}`;
      if (deduplicate && seenMessages.has(key)) {
        const existing = seenMessages.get(key)!;
        // Merge evidence into existing placement (required or retrieved)
        stagedEvidence.push({
          section: existing.section,
          prevMatchedChunkIds: existing.section.matched_chunk_ids
            ? [...existing.section.matched_chunk_ids]
            : undefined,
          prevMatchedRanges: existing.section.matched_ranges
            ? [...existing.section.matched_ranges]
            : undefined,
          prevSerializedBytes: existing.section.serialized_bytes,
          message: existing.message,
          prevProvenance: existing.message.provenance
            ? cloneProvenance(existing.message.provenance)
            : undefined,
        });

        if (includeProvenance && existing.message.provenance) {
          const prov = existing.message.provenance;
          prov.chunk_ids = Array.from(new Set([...(prov.chunk_ids ?? []), candidate.chunkId]));
          if (prov.score === undefined || candidate.score > prov.score) {
            prov.score = candidate.score;
          }
          prov.sources = Array.from(
            new Set([...(prov.sources ?? []), ...(candidate.sources ?? [])]),
          );
        }
        if (!existing.section.matched_chunk_ids) {
          existing.section.matched_chunk_ids = [];
        }
        if (!existing.section.matched_chunk_ids.includes(candidate.chunkId)) {
          existing.section.matched_chunk_ids.push(candidate.chunkId);
        }

        const matchingRanges = candidate.matched_ranges.filter(
          (r) => r.source_node_id === rawMsg.sourceNodeId,
        );
        if (matchingRanges.length > 0) {
          if (!existing.section.matched_ranges) {
            existing.section.matched_ranges = [];
          }
          for (const mr of matchingRanges) {
            if (
              !existing.section.matched_ranges.some(
                (r) =>
                  r.source_node_id === mr.source_node_id &&
                  r.char_start === mr.char_start &&
                  r.char_end === mr.char_end,
              )
            ) {
              existing.section.matched_ranges.push(mr);
            }
          }
        }
        existing.section.serialized_bytes = jsonBytes(existing.section);
      } else {
        const msg: ContextMessage = {
          source_node_id: rawMsg.sourceNodeId,
          role: rawMsg.role ?? null,
          created_at: rawMsg.createdAt,
          updated_at: rawMsg.updatedAt,
          text: rawMsg.text,
          conversation_id: candidate.conversation_id,
          revision_id: candidate.revision_id,
        };
        if (includeProvenance) {
          msg.provenance = {
            kind: "retrieved",
            request_index: candidate.request_index,
            conversation_id: candidate.conversation_id,
            revision_id: candidate.revision_id,
            source_node_id: rawMsg.sourceNodeId,
            chunk_ids: [candidate.chunkId],
            score: candidate.score,
            sources: candidate.sources,
          };
        }
        candidateMessages.push(msg);
      }
    }

    // If all messages were already admitted / attached, check if evidence attachment still fits
    if (candidateMessages.length === 0) {
      if (stagedEvidence.length > 0) {
        const testCompiledText = includeCompiledText
          ? buildCompiledText(admittedSections)
          : undefined;
        const draftTestPack: Record<string, unknown> = {
          status: "complete",
          pack_id: "0".repeat(64),
          namespace: input.namespace ?? null,
          task: input.task,
          revision_pins,
          sections: admittedSections,
          budget: {
            max_estimated_tokens: input.budget.max_estimated_tokens,
            used_estimated_tokens: usedEstimatedTokens,
            max_serialized_bytes: input.budget.max_serialized_bytes,
            used_serialized_bytes: 0,
            estimator: ESTIMATOR_VERSION,
          },
          omitted,
          degraded,
          unavailable: Array.from(unavailableSet).sort(),
          warnings,
          ...(testCompiledText !== undefined ? { compiled_text: testCompiledText } : {}),
        };

        const measuredBytes = computePackSerializedBytes(draftTestPack);
        if (measuredBytes > input.budget.max_serialized_bytes) {
          rollbackStagedEvidence(stagedEvidence);
          omitted.push({
            kind: "retrieved",
            conversation_id: candidate.conversation_id,
            revision_id: candidate.revision_id,
            reason: "budget",
          });
        } else {
          admittedEvidenceOnlyCandidates.push({
            conversation_id: candidate.conversation_id,
            revision_id: candidate.revision_id,
            stagedEvidence,
          });
        }
      }
      continue;
    }

    const candidateTokens = candidateMessages.reduce((sum, m) => sum + estimateTokens(m.text), 0);

    // 1. Check token budget
    if (usedEstimatedTokens + candidateTokens > input.budget.max_estimated_tokens) {
      rollbackStagedEvidence(stagedEvidence);
      omitted.push({
        kind: "retrieved",
        conversation_id: candidate.conversation_id,
        revision_id: candidate.revision_id,
        reason: "budget",
      });
      continue;
    }

    // 2. Filter matched_ranges for candidate section to only retained messages
    const retainedNodeIds = new Set(candidateMessages.map((m) => m.source_node_id));
    const retainedRanges = candidate.matched_ranges.filter((r) =>
      retainedNodeIds.has(r.source_node_id),
    );

    const candidateSection: ContextSection = {
      kind: "retrieved",
      request_index: candidate.request_index,
      title: candidate.title,
      priority: candidate.priority,
      conversation_id: candidate.conversation_id,
      revision_id: candidate.revision_id,
      messages: candidateMessages,
      estimated_tokens: candidateTokens,
      serialized_bytes: 0,
      matched_chunk_ids: [candidate.chunkId],
      ...(retainedRanges.length > 0 ? { matched_ranges: retainedRanges } : {}),
    };
    candidateSection.serialized_bytes = jsonBytes(candidateSection);

    const testSections = [...admittedSections, candidateSection];
    const testCompiledText = includeCompiledText ? buildCompiledText(testSections) : undefined;

    const draftTestPack: Record<string, unknown> = {
      status: "complete",
      pack_id: "0".repeat(64),
      namespace: input.namespace ?? null,
      task: input.task,
      revision_pins,
      sections: testSections,
      budget: {
        max_estimated_tokens: input.budget.max_estimated_tokens,
        used_estimated_tokens: usedEstimatedTokens + candidateTokens,
        max_serialized_bytes: input.budget.max_serialized_bytes,
        used_serialized_bytes: 0,
        estimator: ESTIMATOR_VERSION,
      },
      omitted,
      degraded,
      unavailable: Array.from(unavailableSet).sort(),
      warnings,
      ...(testCompiledText !== undefined ? { compiled_text: testCompiledText } : {}),
    };

    const measuredBytes = computePackSerializedBytes(draftTestPack);
    if (measuredBytes > input.budget.max_serialized_bytes) {
      rollbackStagedEvidence(stagedEvidence);
      omitted.push({
        kind: "retrieved",
        conversation_id: candidate.conversation_id,
        revision_id: candidate.revision_id,
        reason: "budget",
      });
      continue;
    }

    // Admitted!
    admittedSections.push(candidateSection);
    usedEstimatedTokens += candidateTokens;
    if (stagedEvidence.length > 0) {
      candidateEvidenceMap.set(candidateSection, stagedEvidence);
    }

    for (const msg of candidateMessages) {
      const key = `${candidate.conversation_id}:${candidate.revision_id}:${msg.source_node_id}`;
      seenMessages.set(key, { section: candidateSection, message: msg });
    }
  }

  // 7. Recheck current heads for admitted retrieved conversation/revision pairs immediately before final output
  const admittedRetrievedSections = admittedSections.filter((s) => s.kind === "retrieved");
  if (admittedRetrievedSections.length > 0 || admittedEvidenceOnlyCandidates.length > 0) {
    const distinctRetrievedConvIds = Array.from(
      new Set([
        ...admittedRetrievedSections.map((s) => s.conversation_id),
        ...admittedEvidenceOnlyCandidates.map((c) => c.conversation_id),
      ]),
    );
    const headByConvId: Record<string, string | null> = {};

    for (const convId of distinctRetrievedConvIds) {
      const row = await env.MEMORY_DB.prepare(
        `SELECT current_revision_id FROM conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
        .bind(convId, tenant.userId)
        .first<{ current_revision_id: string | null }>();
      headByConvId[convId] = row ? row.current_revision_id : null;
    }

    const staleSections = new Set<ContextSection>();

    for (const sec of admittedRetrievedSections) {
      const currentHead = headByConvId[sec.conversation_id];
      if (currentHead === undefined || currentHead === null || currentHead !== sec.revision_id) {
        staleSections.add(sec);
        omitted.push({
          kind: "retrieved",
          conversation_id: sec.conversation_id,
          revision_id: sec.revision_id,
          reason: "stale_revision",
        });
        addWarning({
          code: "STALE_REVISION",
          conversation_id: sec.conversation_id,
          revision_id: sec.revision_id,
          message: `Retrieved revision "${sec.revision_id}" is stale (current head is "${currentHead ?? "null"}")`,
        });
      }
    }

    for (let i = admittedEvidenceOnlyCandidates.length - 1; i >= 0; i--) {
      const cand = admittedEvidenceOnlyCandidates[i]!;
      const currentHead = headByConvId[cand.conversation_id];
      if (currentHead === undefined || currentHead === null || currentHead !== cand.revision_id) {
        rollbackStagedEvidence(cand.stagedEvidence);
        omitted.push({
          kind: "retrieved",
          conversation_id: cand.conversation_id,
          revision_id: cand.revision_id,
          reason: "stale_revision",
        });
        addWarning({
          code: "STALE_REVISION",
          conversation_id: cand.conversation_id,
          revision_id: cand.revision_id,
          message: `Retrieved revision "${cand.revision_id}" is stale (current head is "${currentHead ?? "null"}")`,
        });
      }
    }
    const remainingEvidenceOnly = admittedEvidenceOnlyCandidates.filter((cand) => {
      const currentHead = headByConvId[cand.conversation_id];
      return currentHead !== undefined && currentHead !== null && currentHead === cand.revision_id;
    });
    admittedEvidenceOnlyCandidates.length = 0;
    admittedEvidenceOnlyCandidates.push(...remainingEvidenceOnly);

    if (staleSections.size > 0) {
      for (let i = admittedSections.length - 1; i >= 0; i--) {
        const sec = admittedSections[i]!;
        if (sec.kind === "retrieved" && staleSections.has(sec)) {
          usedEstimatedTokens -= sec.estimated_tokens;
          const staged = candidateEvidenceMap.get(sec);
          if (staged) {
            rollbackStagedEvidence(staged);
          }
        }
      }
      const remainingSections: ContextSection[] = [];
      for (const sec of admittedSections) {
        if (!(sec.kind === "retrieved" && staleSections.has(sec))) {
          remainingSections.push(sec);
        }
      }
      admittedSections.length = 0;
      admittedSections.push(...remainingSections);
    }
  }
  finalizeWarnings();

  // Update serialized_bytes for every admitted section
  for (const sec of admittedSections) {
    sec.serialized_bytes = jsonBytes(sec);
  }

  let finalCompiledText = includeCompiledText ? buildCompiledText(admittedSections) : undefined;
  let finalPackId = await computePackId(
    env,
    input,
    revision_pins,
    admittedSections,
    finalCompiledText,
  );

  const finalPack: ContextPackComplete = {
    status: "complete",
    pack_id: finalPackId,
    namespace: input.namespace ?? null,
    task: input.task,
    revision_pins,
    sections: admittedSections,
    budget: {
      max_estimated_tokens: input.budget.max_estimated_tokens,
      used_estimated_tokens: usedEstimatedTokens,
      max_serialized_bytes: input.budget.max_serialized_bytes,
      used_serialized_bytes: 0,
      estimator: ESTIMATOR_VERSION,
    },
    omitted,
    degraded,
    unavailable: Array.from(unavailableSet).sort(),
    warnings,
    ...(finalCompiledText !== undefined ? { compiled_text: finalCompiledText } : {}),
  };

  const budgetCeiling = Math.min(input.budget.max_serialized_bytes, MAX_SERIALIZED_BYTES_LIMIT);
  let totalFinalBytes = computePackSerializedBytes(finalPack as unknown as Record<string, unknown>);
  const initialRetrievedSectionsCount = admittedSections.length - requiredSections.length;

  // If optional sections/diagnostics make it too large:
  // 1. Remove lowest-priority retrieved sections (from end of admittedSections)
  while (admittedSections.length > requiredSections.length && totalFinalBytes > budgetCeiling) {
    const popped = admittedSections.pop();
    if (!popped) break;
    usedEstimatedTokens -= popped.estimated_tokens;
    const staged = candidateEvidenceMap.get(popped);
    if (staged) {
      rollbackStagedEvidence(staged);
    }
    omitted.push({
      kind: "retrieved",
      conversation_id: popped.conversation_id,
      revision_id: popped.revision_id,
      reason: "budget",
    });
    for (const sec of admittedSections) {
      sec.serialized_bytes = jsonBytes(sec);
    }
    finalCompiledText = includeCompiledText ? buildCompiledText(admittedSections) : undefined;
    finalPack.sections = admittedSections;
    finalPack.budget.used_estimated_tokens = usedEstimatedTokens;
    if (finalCompiledText !== undefined) {
      finalPack.compiled_text = finalCompiledText;
    } else {
      delete finalPack.compiled_text;
    }
    finalPackId = await computePackId(
      env,
      input,
      revision_pins,
      admittedSections,
      finalCompiledText,
    );
    finalPack.pack_id = finalPackId;
    totalFinalBytes = computePackSerializedBytes(finalPack as unknown as Record<string, unknown>);
  }

  // If budget trimming removed all optional retrieved sections, restore required baseline atomically
  if (initialRetrievedSectionsCount > 0 && admittedSections.length === requiredSections.length) {
    restoreRequiredBaselines(requiredBaselines);
    for (const cand of admittedEvidenceOnlyCandidates) {
      omitted.push({
        kind: "retrieved",
        conversation_id: cand.conversation_id,
        revision_id: cand.revision_id,
        reason: "budget",
      });
    }
    admittedEvidenceOnlyCandidates.length = 0;

    for (const sec of admittedSections) {
      sec.serialized_bytes = jsonBytes(sec);
    }
    finalCompiledText = includeCompiledText ? buildCompiledText(admittedSections) : undefined;
    if (finalCompiledText !== undefined) {
      finalPack.compiled_text = finalCompiledText;
    } else {
      delete finalPack.compiled_text;
    }
    finalPackId = await computePackId(
      env,
      input,
      revision_pins,
      admittedSections,
      finalCompiledText,
    );
    finalPack.pack_id = finalPackId;
    totalFinalBytes = computePackSerializedBytes(finalPack as unknown as Record<string, unknown>);
  }

  // 2. If only required sections remain and it is still too large,
  // roll back all evidence attached to required sections and bound omission/warning metadata
  if (totalFinalBytes > budgetCeiling) {
    restoreRequiredBaselines(requiredBaselines);
    for (const cand of admittedEvidenceOnlyCandidates) {
      omitted.push({
        kind: "retrieved",
        conversation_id: cand.conversation_id,
        revision_id: cand.revision_id,
        reason: "budget",
      });
    }
    admittedEvidenceOnlyCandidates.length = 0;

    for (const sec of admittedSections) {
      sec.serialized_bytes = jsonBytes(sec);
    }
    finalCompiledText = includeCompiledText ? buildCompiledText(admittedSections) : undefined;
    if (finalCompiledText !== undefined) {
      finalPack.compiled_text = finalCompiledText;
    } else {
      delete finalPack.compiled_text;
    }
    totalFinalBytes = computePackSerializedBytes(finalPack as unknown as Record<string, unknown>);

    while (warnings.length > 0 && totalFinalBytes > budgetCeiling) {
      if (!evictWarningDetailForBudget()) break;
      totalFinalBytes = computePackSerializedBytes(finalPack as unknown as Record<string, unknown>);
    }
    while (omitted.length > 0 && totalFinalBytes > budgetCeiling) {
      omitted.pop();
      totalFinalBytes = computePackSerializedBytes(finalPack as unknown as Record<string, unknown>);
    }
    if (totalFinalBytes > budgetCeiling && warnings.at(-1)?.code === "DIAGNOSTICS_TRUNCATED") {
      warnings.pop();
      totalFinalBytes = computePackSerializedBytes(finalPack as unknown as Record<string, unknown>);
    }
    if (totalFinalBytes > budgetCeiling && unavailableSet.size > 0) {
      unavailableSet.clear();
      finalPack.unavailable = [];
    }
  }

  finalPackId = await computePackId(env, input, revision_pins, admittedSections, finalCompiledText);
  finalPack.pack_id = finalPackId;
  totalFinalBytes = computePackSerializedBytes(finalPack as unknown as Record<string, unknown>);
  finalPack.budget.used_serialized_bytes = totalFinalBytes;
  return finalPack;
}
