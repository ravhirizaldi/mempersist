import type { AppEnv } from "./domain";
import { enqueueIndex } from "./jobs";
import {
  boundCompactPage,
  compactConversationPage,
  conversationPage,
  jsonBytes,
  COMPACT_RESPONSE_BYTES,
} from "./retrieval";
import {
  loadCanonicalRevision,
  loadConversationTags,
  type RestoredRevision,
  type StoredRevision,
} from "./storage";

type WrittenMessage = { role: string; content: string; timestamp?: string | undefined };

export async function verifyCommittedWrite(
  env: AppEnv,
  stored: StoredRevision,
  intended: WrittenMessage[],
) {
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
) {
  let indexing;
  try {
    const jobId = await enqueueIndex(env, stored.revisionId);
    indexing = { status: "queued" as const, job_id: jobId };
  } catch {
    indexing = {
      status: "failed" as const,
      error: {
        code: "DERIVED_INDEXING",
        message: "Canonical revision saved; indexing could not be queued",
        retryable: true,
      },
    };
  }
  return {
    conversation_id: stored.conversationId,
    revision_id: stored.revisionId,
    durable: true,
    indexing,
    ...(verify ? { verification: await verifyCommittedWrite(env, stored, messages) } : {}),
  };
}

export async function verifyRestoredRevision(env: AppEnv, restored: RestoredRevision) {
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
) {
  let indexing;
  try {
    const jobId = await enqueueIndex(env, restored.revisionId);
    indexing = { status: "queued" as const, job_id: jobId };
  } catch {
    indexing = {
      status: "failed" as const,
      error: {
        code: "DERIVED_INDEXING",
        message: "Canonical revision restored; indexing could not be queued",
        retryable: true,
      },
    };
  }
  return {
    conversation_id: restored.conversationId,
    previous_revision_id: restored.previousRevisionId,
    revision_id: restored.revisionId,
    durable: true,
    indexing,
    ...(verify ? { verification: await verifyRestoredRevision(env, restored) } : {}),
  };
}
