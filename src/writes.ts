import type { AppEnv, CanonicalNode, MessageEditOperation } from "./domain";
import { enqueueIndex } from "./jobs";
import { COMPACT_RESPONSE_BYTES, MUTATION_RECEIPT_MAX_SERIALIZED_BYTES } from "./limits";
import {
  boundCompactPage,
  compactConversationPage,
  conversationPage,
  jsonBytes,
  type CompactPage,
} from "./retrieval";
import {
  loadCanonicalRevision,
  loadConversationTags,
  type ConversationMessageEditResult,
  type RestoredRevision,
  type StoredRevision,
} from "./storage";

type WrittenMessage = { role: string; content: string; timestamp?: string | undefined };

// Bounded receipts: post-commit mutation receipts must never fail on the 64 KiB
// toolResult guard, so oversized envelopes drop fields in a fixed ladder order.
export const MUTATION_RECEIPT_ENVELOPE_HEADROOM = 512;
export const MUTATION_RECEIPT_ERROR_MESSAGE_LIMIT = 200;
export const MUTATION_RECEIPT_ERROR_MESSAGE_FLOOR = 80;

export interface MutationReceiptReadbackSelector {
  conversation_id: string;
  revision_id: string;
  offset: number;
  limit: number;
  branch: "active" | "all";
}

export interface MutationReceiptVerification {
  status: "passed" | "failed";
  revision_id: string;
  checked_messages?: number;
  readback_available: boolean;
  error?: { code: string; message: string };
  readback?: CompactPage;
  readback_error?: { code: string; message: string; offset: number };
}

export interface MutationReceiptIndexing {
  status: "queued" | "failed";
  job_id?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface MutationReceiptItem {
  request_index?: number;
  status?: string;
  conversation_id?: string;
  previous_revision_id?: string;
  revision_id?: string;
  durable?: boolean;
  indexing?: MutationReceiptIndexing;
  verification?: MutationReceiptVerification;
  source_conversation_id?: string;
  source_revision_id?: string;
  error?: { code: string; message: string };
}

function boundedErrorMessage(message: string): string {
  return message.length > MUTATION_RECEIPT_ERROR_MESSAGE_LIMIT
    ? message.slice(0, MUTATION_RECEIPT_ERROR_MESSAGE_LIMIT)
    : message;
}

export interface MutationReceiptBudget {
  used_serialized_bytes: number;
  max_serialized_bytes: number;
}

export interface MemoryWriteReceiptDraft {
  conversation_id: string;
  revision_id: string;
  durable: true;
  indexing: MutationReceiptIndexing;
  verification?: MutationReceiptVerification;
  readback_requests?: MutationReceiptReadbackSelector[];
  omitted?: string[];
}

export interface MemoryRestoreReceiptDraft extends MemoryWriteReceiptDraft {
  previous_revision_id: string;
}

export type MemoryWriteReceipt = MemoryWriteReceiptDraft & MutationReceiptBudget;
export type MemoryRestoreReceipt = MemoryRestoreReceiptDraft & MutationReceiptBudget;

interface MutationReceiptLadderRung {
  path: string;
  apply: () => void;
}

export function fitMutationReceipt<Item extends MutationReceiptItem, Body extends object>(options: {
  items: Item[];
  readbackRequests?: MutationReceiptReadbackSelector[];
  wrap: (payload: {
    items: Item[];
    readback_requests: MutationReceiptReadbackSelector[];
    omitted: string[];
  }) => Body;
  maxSerializedBytes?: number;
}): {
  value: Body & MutationReceiptBudget;
  omitted: string[];
  usedBytes: number;
  maxBytes: number;
} {
  const maxBytes = Math.max(
    1,
    Math.min(
      options.maxSerializedBytes ?? MUTATION_RECEIPT_MAX_SERIALIZED_BYTES,
      MUTATION_RECEIPT_MAX_SERIALIZED_BYTES,
    ),
  );
  const items = structuredClone(options.items);
  // Widened view of the cloned items for property shedding; shares object references.
  const drafts: MutationReceiptItem[] = items;
  const readbackRequests = [...(options.readbackRequests ?? [])];
  const omitted: string[] = [];
  const addOmitted = (path: string): void => {
    if (!omitted.includes(path)) omitted.push(path);
  };
  const draftBytes = (): number =>
    jsonBytes(options.wrap({ items, readback_requests: readbackRequests, omitted }));
  const fits = (): boolean => draftBytes() + MUTATION_RECEIPT_ENVELOPE_HEADROOM <= maxBytes;

  // Step 1: strip inline readback everywhere, then restore it item by item while it fits.
  const savedInline = drafts.map((item) => {
    const verification = item.verification;
    if (!verification) return undefined;
    const readback = verification.readback;
    const readback_error = verification.readback_error;
    if (readback === undefined && readback_error === undefined) return undefined;
    delete verification.readback;
    delete verification.readback_error;
    return { readback, readback_error };
  });
  let inlineShed = false;
  for (let index = 0; index < drafts.length; index += 1) {
    const saved = savedInline[index];
    const verification = drafts[index]?.verification;
    if (!saved || !verification) continue;
    if (saved.readback !== undefined) verification.readback = saved.readback;
    if (saved.readback_error !== undefined) verification.readback_error = saved.readback_error;
    if (fits()) continue;
    delete verification.readback;
    delete verification.readback_error;
    if (!inlineShed) {
      inlineShed = true;
      addOmitted("verification.readback");
    }
  }

  // Step 2: cumulative ladder, applied in order and stopped as soon as the envelope fits.
  const ladder: MutationReceiptLadderRung[] = [
    {
      path: "readback_requests",
      apply: () => {
        readbackRequests.length = 0;
      },
    },
    {
      path: "verification.readback_error",
      apply: () => {
        for (const item of drafts) {
          if (item.verification) delete item.verification.readback_error;
        }
      },
    },
    {
      path: "verification.checked_messages",
      apply: () => {
        for (const item of drafts) {
          if (item.verification) delete item.verification.checked_messages;
        }
      },
    },
    {
      path: "indexing.error",
      apply: () => {
        for (const item of drafts) {
          if (item.indexing) delete item.indexing.error;
        }
      },
    },
    {
      path: "indexing.job_id",
      apply: () => {
        for (const item of drafts) {
          if (item.indexing) delete item.indexing.job_id;
        }
      },
    },
    {
      path: "source_revision_id",
      apply: () => {
        for (const item of drafts) delete item.source_revision_id;
      },
    },
    {
      path: "source_conversation_id",
      apply: () => {
        for (const item of drafts) delete item.source_conversation_id;
      },
    },
    {
      path: "error.message",
      apply: () => {
        for (const item of drafts) {
          if (item.error) {
            item.error.message = item.error.message.slice(0, MUTATION_RECEIPT_ERROR_MESSAGE_FLOOR);
          }
        }
      },
    },
    {
      path: "error.message",
      apply: () => {
        for (const item of drafts) {
          if (item.error) Reflect.deleteProperty(item.error, "message");
        }
      },
    },
  ];
  let rung = 0;
  const applyNextRung = (): void => {
    const current = ladder[rung];
    if (!current) return;
    current.apply();
    addOmitted(current.path);
    rung += 1;
  };
  while (rung < ladder.length && !fits()) applyNextRung();

  // Same fixed-point byte accounting as context packs so used_serialized_bytes is exact.
  const buildValue = (): Body & MutationReceiptBudget => {
    const value: Body & MutationReceiptBudget = {
      ...options.wrap({ items, readback_requests: readbackRequests, omitted }),
      max_serialized_bytes: maxBytes,
      used_serialized_bytes: 0,
    };
    const baseBytes = jsonBytes(value);
    let n = baseBytes;
    for (let i = 0; i < 10; i += 1) {
      const next = baseBytes - 1 + String(n).length;
      if (next === n) break;
      n = next;
    }
    value.used_serialized_bytes = n;
    const actual = jsonBytes(value);
    if (actual !== n) value.used_serialized_bytes = actual;
    return value;
  };
  let value = buildValue();
  // Headroom is fitting slack: the real envelope must still fit on its own.
  while (jsonBytes(value) > maxBytes && rung < ladder.length) {
    applyNextRung();
    value = buildValue();
  }
  return { value, omitted, usedBytes: jsonBytes(value), maxBytes };
}

export async function verifyCommittedWrite(
  env: AppEnv,
  stored: StoredRevision,
  intended: WrittenMessage[],
): Promise<MutationReceiptVerification> {
  try {
    const { conversation } = await loadCanonicalRevision(env, stored.revisionId, stored);
    const offset = stored.writeOffset ?? 0;
    const byId = new Map(conversation.nodes.map((node) => [node.sourceNodeId, node]));
    const saved = conversation.activeSourceNodeIds.slice(offset).map((id) => byId.get(id));
    const matches =
      saved.length === intended.length &&
      intended.every((message, index) => {
        const node = saved[index];
        return (
          node?.role === message.role &&
          node.text === message.content &&
          (message.timestamp === undefined || node.createdAt === message.timestamp)
        );
      });
    const readback = boundCompactPage(
      compactConversationPage(
        conversationPage(conversation, stored.revisionId, conversation.tags, offset, 100),
        offset,
      ),
    );
    return {
      status: matches ? ("passed" as const) : ("failed" as const),
      revision_id: stored.revisionId,
      checked_messages: saved.length,
      readback_available: true,
      ...(matches
        ? {}
        : {
            error: {
              code: "CANONICAL_STORAGE",
              message: "Persisted messages differ from the intended write",
            },
          }),
      ...(jsonBytes(readback) <= COMPACT_RESPONSE_BYTES
        ? { readback }
        : {
            readback_error: {
              code: "RESPONSE_TOO_LARGE",
              message: "Conversation metadata exceeds the readback budget",
              offset,
            },
          }),
    };
  } catch {
    return {
      status: "failed" as const,
      revision_id: stored.revisionId,
      readback_available: false,
      error: {
        code: "CANONICAL_STORAGE",
        message: "Committed revision could not be read and verified",
      },
    };
  }
}

// Everything here happens after canonical commit; later failures must retain its receipt.
export async function completeMemoryWrite(
  env: AppEnv,
  stored: StoredRevision,
  messages: WrittenMessage[],
  verify: boolean,
): Promise<MemoryWriteReceipt> {
  let indexing: MutationReceiptIndexing;
  try {
    const jobId = await enqueueIndex(env, stored.revisionId);
    indexing = { status: "queued", job_id: jobId };
  } catch {
    indexing = {
      status: "failed",
      error: {
        code: "DERIVED_INDEXING",
        message: boundedErrorMessage("Canonical revision saved; indexing could not be queued"),
        retryable: true,
      },
    };
  }
  const verification = verify ? await verifyCommittedWrite(env, stored, messages) : undefined;
  const readbackRequests: MutationReceiptReadbackSelector[] =
    verify && verification?.readback_available
      ? [
          {
            conversation_id: stored.conversationId,
            revision_id: stored.revisionId,
            offset: stored.writeOffset ?? 0,
            limit: 20,
            branch: "active",
          },
        ]
      : [];
  const draft: MemoryWriteReceiptDraft = {
    conversation_id: stored.conversationId,
    revision_id: stored.revisionId,
    durable: true,
    indexing,
    ...(verification ? { verification } : {}),
  };
  return fitMutationReceipt({
    items: [draft],
    ...(readbackRequests.length ? { readbackRequests } : {}),
    wrap: ({ items: merged, readback_requests, omitted }): MemoryWriteReceiptDraft => ({
      ...merged[0]!,
      ...(readback_requests.length ? { readback_requests } : {}),
      ...(omitted.length ? { omitted } : {}),
    }),
  }).value;
}

export async function verifyRestoredRevision(
  env: AppEnv,
  restored: RestoredRevision,
): Promise<MutationReceiptVerification> {
  try {
    const { conversation } = await loadCanonicalRevision(env, restored.revisionId, restored);
    const row = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ? AND deleted_at IS NULL",
    )
      .bind(restored.conversationId)
      .first<{ current_revision_id: string }>();
    const matches = row?.current_revision_id === restored.revisionId;
    const tags =
      (await loadConversationTags(env, [restored.conversationId])).get(restored.conversationId) ??
      [];
    const offset = 0;
    const readback = boundCompactPage(
      compactConversationPage(
        conversationPage(conversation, restored.revisionId, tags, offset, 100),
        offset,
      ),
    );
    return {
      status: matches ? ("passed" as const) : ("failed" as const),
      revision_id: restored.revisionId,
      checked_messages: conversation.activeSourceNodeIds.length,
      readback_available: true,
      ...(matches
        ? {}
        : {
            error: {
              code: "CANONICAL_STORAGE",
              message: "Conversation head does not match the restored revision",
            },
          }),
      ...(jsonBytes(readback) <= COMPACT_RESPONSE_BYTES
        ? { readback }
        : {
            readback_error: {
              code: "RESPONSE_TOO_LARGE",
              message: "Conversation metadata exceeds the readback budget",
              offset,
            },
          }),
    };
  } catch {
    return {
      status: "failed" as const,
      revision_id: restored.revisionId,
      readback_available: false,
      error: {
        code: "CANONICAL_STORAGE",
        message: "Restored revision could not be read and verified",
      },
    };
  }
}

export async function completeMemoryRestore(
  env: AppEnv,
  restored: RestoredRevision,
  verify: boolean,
): Promise<MemoryRestoreReceipt> {
  let indexing: MutationReceiptIndexing;
  try {
    const jobId = await enqueueIndex(env, restored.revisionId);
    indexing = { status: "queued", job_id: jobId };
  } catch {
    indexing = {
      status: "failed",
      error: {
        code: "DERIVED_INDEXING",
        message: boundedErrorMessage("Canonical revision restored; indexing could not be queued"),
        retryable: true,
      },
    };
  }
  const verification = verify ? await verifyRestoredRevision(env, restored) : undefined;
  const readbackRequests: MutationReceiptReadbackSelector[] =
    verify && verification?.readback_available
      ? [
          {
            conversation_id: restored.conversationId,
            revision_id: restored.revisionId,
            offset: 0,
            limit: 20,
            branch: "active",
          },
        ]
      : [];
  const draft: MemoryRestoreReceiptDraft = {
    conversation_id: restored.conversationId,
    previous_revision_id: restored.previousRevisionId,
    revision_id: restored.revisionId,
    durable: true,
    indexing,
    ...(verification ? { verification } : {}),
  };
  return fitMutationReceipt({
    items: [draft],
    ...(readbackRequests.length ? { readbackRequests } : {}),
    wrap: ({ items: merged, readback_requests, omitted }): MemoryRestoreReceiptDraft => ({
      ...merged[0]!,
      ...(readback_requests.length ? { readback_requests } : {}),
      ...(omitted.length ? { omitted } : {}),
    }),
  }).value;
}

export async function verifyCopiedRevision(
  env: AppEnv,
  stored: StoredRevision,
): Promise<MutationReceiptVerification> {
  try {
    const { conversation } = await loadCanonicalRevision(env, stored.revisionId, stored);
    const row = await env.MEMORY_DB.prepare(
      "SELECT current_revision_id FROM conversations WHERE id = ? AND deleted_at IS NULL",
    )
      .bind(stored.conversationId)
      .first<{ current_revision_id: string }>();
    const matches =
      row?.current_revision_id === stored.revisionId &&
      conversation.derivedFrom?.operation === "copy";
    const tags =
      (await loadConversationTags(env, [stored.conversationId])).get(stored.conversationId) ?? [];
    const offset = 0;
    const readback = boundCompactPage(
      compactConversationPage(
        conversationPage(conversation, stored.revisionId, tags, offset, 100),
        offset,
      ),
    );
    return {
      status: matches ? ("passed" as const) : ("failed" as const),
      revision_id: stored.revisionId,
      checked_messages: conversation.activeSourceNodeIds.length,
      readback_available: true,
      ...(matches
        ? {}
        : {
            error: {
              code: "CANONICAL_STORAGE",
              message: "Conversation head or provenance does not match the copied revision",
            },
          }),
      ...(jsonBytes(readback) <= COMPACT_RESPONSE_BYTES
        ? { readback }
        : {
            readback_error: {
              code: "RESPONSE_TOO_LARGE",
              message: "Conversation metadata exceeds the readback budget",
              offset,
            },
          }),
    };
  } catch {
    return {
      status: "failed" as const,
      revision_id: stored.revisionId,
      readback_available: false,
      error: {
        code: "CANONICAL_STORAGE",
        message: "Copied revision could not be read and verified",
      },
    };
  }
}

export async function completeMemoryCopy(env: AppEnv, stored: StoredRevision, verify: boolean) {
  let indexing: MutationReceiptIndexing;
  try {
    const jobId = await enqueueIndex(env, stored.revisionId);
    indexing = { status: "queued", job_id: jobId };
  } catch {
    indexing = {
      status: "failed",
      error: {
        code: "DERIVED_INDEXING",
        message: boundedErrorMessage("Canonical revision copied; indexing could not be queued"),
        retryable: true,
      },
    };
  }
  return {
    conversation_id: stored.conversationId,
    revision_id: stored.revisionId,
    durable: true,
    indexing,
    ...(verify ? { verification: await verifyCopiedRevision(env, stored) } : {}),
  };
}

// memory_edit_messages receipts: one core item carries indexing/verification so
// the shared shed ladder can drop their heavier fields, and one item per target
// keeps request_index/source_node_id/operation/status under the 100-edit envelope.
export interface MemoryEditReceiptEdit {
  request_index: number;
  source_node_id: string;
  operation: MessageEditOperation;
  status: "edited" | "unchanged";
}

export interface MemoryEditReceiptDraft {
  conversation_id: string;
  previous_revision_id: string;
  revision_id: string;
  status: "edited" | "no_change";
  durable: true;
  edits: MemoryEditReceiptEdit[];
  indexing?: MutationReceiptIndexing;
  verification?: MutationReceiptVerification;
  readback_requests?: MutationReceiptReadbackSelector[];
  omitted?: string[];
}

export type MemoryEditReceipt = MemoryEditReceiptDraft & MutationReceiptBudget;

interface EditReceiptItem extends MutationReceiptItem {
  status?: "edited" | "unchanged";
  source_node_id?: string;
  operation?: MessageEditOperation;
}

function targetedReadbackPage(
  meta: {
    conversationId: string;
    revisionId: string;
    title: string;
    namespace: string;
    tags: string[];
  },
  nodes: CanonicalNode[],
): CompactPage {
  return {
    conversation: {
      id: meta.conversationId,
      revisionId: meta.revisionId,
      title: meta.title,
      namespace: meta.namespace,
      tags: meta.tags,
    },
    messages: nodes.map((node) => ({
      sourceNodeId: node.sourceNodeId,
      role: node.role,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      text: node.text,
    })),
    offset: 0,
    nextOffset: null,
    total: nodes.length,
    oversizedMessage: null,
  };
}

// Reloads the committed revision from R2, validates its canonical integrity, and
// checks every requested target's final text plus its preserved role/createdAt
// against the base revision. Readback is limited to the requested targets.
export async function verifyEditedRevision(
  env: AppEnv,
  result: ConversationMessageEditResult,
): Promise<MutationReceiptVerification> {
  try {
    const committed = await loadCanonicalRevision(
      env,
      result.revisionId,
      result.revision ?? undefined,
    );
    const targetsById = new Map(
      committed.conversation.nodes.map((node) => [node.sourceNodeId, node]),
    );
    const originals = result.allUnchanged
      ? committed.conversation.nodes
      : (await loadCanonicalRevision(env, result.previousRevisionId)).conversation.nodes;
    const originalsById = new Map(originals.map((node) => [node.sourceNodeId, node]));
    const targets = result.edits.map((edit) => targetsById.get(edit.sourceNodeId));
    const matches = result.edits.every((edit, index) => {
      const node = targets[index];
      const original = originalsById.get(edit.sourceNodeId);
      return (
        node !== undefined &&
        original !== undefined &&
        node.text === edit.text &&
        node.role === original.role &&
        node.createdAt === original.createdAt
      );
    });
    const readback = targetedReadbackPage(
      {
        conversationId: result.conversationId,
        revisionId: result.revisionId,
        title: committed.manifest.title,
        namespace: committed.manifest.namespace,
        tags: committed.manifest.tags ?? [],
      },
      targets.filter((node): node is CanonicalNode => node !== undefined),
    );
    return {
      status: matches ? ("passed" as const) : ("failed" as const),
      revision_id: result.revisionId,
      checked_messages: result.edits.length,
      readback_available: true,
      ...(matches
        ? {}
        : {
            error: {
              code: "CANONICAL_STORAGE",
              message: "Persisted message edits differ from the intended write",
            },
          }),
      ...(jsonBytes(readback) <= COMPACT_RESPONSE_BYTES
        ? { readback }
        : {
            readback_error: {
              code: "RESPONSE_TOO_LARGE",
              message: "Targeted edit readback exceeds the readback budget",
              offset: 0,
            },
          }),
    };
  } catch {
    return {
      status: "failed" as const,
      revision_id: result.revisionId,
      readback_available: false,
      error: {
        code: "CANONICAL_STORAGE",
        message: "Edited revision could not be read and verified",
      },
    };
  }
}

// Indexing is queued only for a changed result (already committed and head-CASed
// by storage); a no_change result never enqueues and never reports indexing.
export async function completeMemoryEdit(
  env: AppEnv,
  result: ConversationMessageEditResult,
  verify: boolean,
): Promise<MemoryEditReceipt> {
  let indexing: MutationReceiptIndexing | undefined;
  if (!result.allUnchanged && result.revision) {
    try {
      const jobId = await enqueueIndex(env, result.revision.revisionId);
      indexing = { status: "queued", job_id: jobId };
    } catch {
      indexing = {
        status: "failed",
        error: {
          code: "DERIVED_INDEXING",
          message: boundedErrorMessage("Canonical revision edited; indexing could not be queued"),
          retryable: true,
        },
      };
    }
  }
  const verification = verify ? await verifyEditedRevision(env, result) : undefined;
  const readbackRequests: MutationReceiptReadbackSelector[] =
    verify && verification?.readback_available
      ? [
          {
            conversation_id: result.conversationId,
            revision_id: result.revisionId,
            offset: 0,
            limit: 20,
            // Edit selectors carry no per-source-node filter, and the inline
            // readback is already targeted at the edited nodes. Edits can
            // target inactive graph nodes, so "all" keeps every shed target
            // recoverable through memory_get_conversations.
            branch: "all",
          },
        ]
      : [];
  const core: EditReceiptItem = {
    ...(indexing ? { indexing } : {}),
    ...(verification ? { verification } : {}),
  };
  const editItems: EditReceiptItem[] = result.edits.map((edit) => ({
    request_index: edit.requestIndex,
    source_node_id: edit.sourceNodeId,
    operation: edit.operation,
    status: edit.status,
  }));
  return fitMutationReceipt({
    items: [core, ...editItems],
    ...(readbackRequests.length ? { readbackRequests } : {}),
    wrap: ({ items: merged, readback_requests, omitted }): MemoryEditReceiptDraft => {
      const [coreItem, ...edits] = merged;
      return {
        conversation_id: result.conversationId,
        previous_revision_id: result.previousRevisionId,
        revision_id: result.revisionId,
        status: result.status,
        durable: true,
        edits: edits.map((item) => ({
          request_index: item.request_index!,
          source_node_id: item.source_node_id!,
          operation: item.operation!,
          status: item.status!,
        })),
        ...(coreItem?.indexing ? { indexing: coreItem.indexing } : {}),
        ...(coreItem?.verification ? { verification: coreItem.verification } : {}),
        ...(readback_requests.length ? { readback_requests } : {}),
        ...(omitted.length ? { omitted } : {}),
      };
    },
  }).value;
}
