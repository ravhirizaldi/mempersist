import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv, CanonicalConversation, CanonicalNode } from "../src/domain";
import { getMessages, type ExactMessageResult } from "../src/retrieval";
import * as storage from "../src/storage";
import { appendConversation, writeCanonicalConversation } from "../src/storage";
import { grantNamespace, getOrCreateUser, OWNER_DB_USER_ID } from "../src/tenant";
const appEnv = env as unknown as AppEnv;

function fixture(
  namespace: string,
  id: string,
  texts: string[],
  keyed = false,
): CanonicalConversation {
  const nodes: CanonicalNode[] = texts.map((text, index) => ({
    id: `${id}-internal-${index}`,
    sourceNodeId: `${id}-node-${index}`,
    parentSourceNodeId: index ? `${id}-node-${index - 1}` : null,
    childSourceNodeIds: index + 1 < texts.length ? [`${id}-node-${index + 1}`] : [],
    role: index % 2 ? "assistant" : "user",
    text,
    content: {},
    createdAt: `2026-01-01T00:00:0${index}.000Z`,
    updatedAt: null,
    modelSlug: null,
    metadata: {},
    raw: {},
    ...(keyed ? { messageKey: index === 0 ? "state.relationship" : "state.location" } : {}),
  }));
  return {
    id,
    sourceType: "synthetic",
    sourceId: id,
    title: "Synthetic exact lookup",
    namespace,
    activeSourceNodeIds: nodes.length ? [nodes[0]!.sourceNodeId] : [],
    tags: [],
    createdAt: nodes[0]?.createdAt ?? null,
    updatedAt: nodes.at(-1)?.createdAt ?? null,
    currentSourceNodeId: nodes.at(-1)?.sourceNodeId ?? null,
    nodes,
    metadata: {},
    anomalies: [],
    derivedFrom: null,
  };
}

async function seed(namespace: string, texts: string[], keyed = false) {
  await grantNamespace(env, OWNER_DB_USER_ID, namespace);
  const conversation = fixture(namespace, crypto.randomUUID(), texts, keyed);
  const stored = await writeCanonicalConversation(env, conversation, null, null, OWNER_DB_USER_ID);
  return { conversation, revisionId: stored.revisionId, segmentKey: stored.segmentKey };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exact canonical message lookup", () => {
  it("resolves active, inactive, keyed, duplicate, Unicode, and missing selectors", async () => {
    const seeded = await seed(`messages-${crypto.randomUUID()}`, ["héllo 🌍", "inactive"], true);
    const result = await getMessages(
      appEnv,
      {
        requests: [
          {
            conversation_id: seeded.conversation.id,
            source_node_id: `${seeded.conversation.id}-node-0`,
          },
          {
            conversation_id: seeded.conversation.id,
            source_node_id: `${seeded.conversation.id}-node-0`,
          },
          { conversation_id: seeded.conversation.id, message_key: "state.location" },
          { conversation_id: seeded.conversation.id, source_node_id: "missing" },
        ],
      },
      [seeded.conversation.namespace],
      OWNER_DB_USER_ID,
    );
    expect(result.results.map((entry) => entry.status)).toEqual(["ok", "ok", "ok", "error"]);
    expect(result.results[0]?.message?.text).toBe("héllo 🌍");
    expect(result.results[1]?.message).toEqual(result.results[0]?.message);
    expect(result.results[2]?.message?.messageKey).toBe("state.location");
    expect(result.results[3]?.error?.code).toBe("NOT_FOUND");
  });
  it("rejects ambiguous canonical message keys without choosing a node", async () => {
    const seeded = await seed(`messages-${crypto.randomUUID()}`, ["one", "two"], true);
    const segment = await env.MEMORY_BUCKET.get(seeded.segmentKey);
    const segmentText = await segment!.text();
    const corruptedSegment = segmentText.replace(
      '"messageKey":"state.location"',
      '"messageKey":"state.relationship"',
    );
    await env.MEMORY_BUCKET.put(seeded.segmentKey, corruptedSegment);
    try {
      const result = await getMessages(
        appEnv,
        {
          requests: [
            { conversation_id: seeded.conversation.id, message_key: "state.relationship" },
          ],
        },
        [seeded.conversation.namespace],
        OWNER_DB_USER_ID,
      );
      expect(result.results[0]?.status).toBe("error");
      expect(result.results[0]?.error?.code).toBe("CANONICAL_STORAGE");
    } finally {
      await env.MEMORY_BUCKET.put(seeded.segmentKey, segmentText);
    }
  });
  it("returns a categorized error for malformed canonical JSON", async () => {
    const seeded = await seed(`messages-${crypto.randomUUID()}`, ["one"]);
    const segment = await env.MEMORY_BUCKET.get(seeded.segmentKey);
    const segmentText = await segment!.text();
    const corruptedSegment = segmentText
      .split("\n")
      .map((line, index) => (index === 1 ? "{not-json" : line))
      .join("\n");
    await env.MEMORY_BUCKET.put(seeded.segmentKey, corruptedSegment);
    try {
      const result = await getMessages(
        appEnv,
        {
          requests: [
            {
              conversation_id: seeded.conversation.id,
              source_node_id: `${seeded.conversation.id}-node-0`,
            },
          ],
        },
        [seeded.conversation.namespace],
        OWNER_DB_USER_ID,
      );
      expect(result.results[0]?.status).toBe("error");
      expect(result.results[0]?.error?.code).toBe("CANONICAL_STORAGE");
    } finally {
      await env.MEMORY_BUCKET.put(seeded.segmentKey, segmentText);
    }
  });

  it("loads each pinned revision once and preserves duplicate ordering", async () => {
    const seeded = await seed(`messages-${crypto.randomUUID()}`, ["before"]);
    const loader = vi.spyOn(storage, "loadCanonicalRevision");
    const first = await getMessages(
      appEnv,
      {
        requests: [
          {
            conversation_id: seeded.conversation.id,
            source_node_id: `${seeded.conversation.id}-node-0`,
          },
          {
            conversation_id: seeded.conversation.id,
            source_node_id: `${seeded.conversation.id}-node-0`,
          },
        ],
      },
      [seeded.conversation.namespace],
      OWNER_DB_USER_ID,
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.results[0]?.revision_id).toBe(seeded.revisionId);
    expect(first.results[1]?.message).toEqual(first.results[0]?.message);
  });
  it("resolves mixed explicit revisions in request order", async () => {
    const seeded = await seed(`messages-${crypto.randomUUID()}`, ["base"]);
    const appended = await appendConversation(
      appEnv,
      seeded.conversation.id,
      seeded.revisionId,
      [{ role: "assistant", content: "appended" }],
      undefined,
      [seeded.conversation.namespace],
      OWNER_DB_USER_ID,
    );
    const appendedConversation = await storage.loadCanonicalRevision(appEnv, appended.revisionId);
    const appendedNode = appendedConversation.conversation.nodes.at(-1)!;
    const result = await getMessages(
      appEnv,
      {
        requests: [
          {
            conversation_id: seeded.conversation.id,
            revision_id: seeded.revisionId,
            source_node_id: `${seeded.conversation.id}-node-0`,
          },
          {
            conversation_id: seeded.conversation.id,
            revision_id: appended.revisionId,
            source_node_id: appendedNode.sourceNodeId,
          },
        ],
      },
      [seeded.conversation.namespace],
      OWNER_DB_USER_ID,
    );

    expect(result.results.map((entry) => entry.revision_id)).toEqual([
      seeded.revisionId,
      appended.revisionId,
    ]);
    expect(result.results.map((entry) => entry.message?.text)).toEqual(["base", "appended"]);
  });

  it("pins current revisions before a head changes", async () => {
    const seeded = await seed(`messages-${crypto.randomUUID()}`, ["before"]);
    const originalLoader = storage.loadCanonicalRevision;
    let advanced = false;
    vi.spyOn(storage, "loadCanonicalRevision").mockImplementation(
      async (environment, revisionId) => {
        if (!advanced) {
          advanced = true;
          await appendConversation(
            appEnv,
            seeded.conversation.id,
            seeded.revisionId,
            [{ role: "assistant", content: "after" }],
            undefined,
            [seeded.conversation.namespace],
            OWNER_DB_USER_ID,
          );
        }
        return originalLoader(environment, revisionId);
      },
    );
    const first = await getMessages(
      appEnv,
      {
        requests: [
          {
            conversation_id: seeded.conversation.id,
            source_node_id: `${seeded.conversation.id}-node-0`,
          },
        ],
      },
      [seeded.conversation.namespace],
      OWNER_DB_USER_ID,
    );
    expect(first.results[0]?.revision_id).toBe(seeded.revisionId);
    expect(first.results[0]?.message?.text).toBe("before");
  });
  it("accepts the maximum ordered request batch", async () => {
    const seeded = await seed(`messages-${crypto.randomUUID()}`, ["batch"]);
    const requests = Array.from({ length: 100 }, () => ({
      conversation_id: seeded.conversation.id,
      source_node_id: `${seeded.conversation.id}-node-0`,
    }));
    const byRequestIndex = new Map<number, ExactMessageResult>();
    let cursor: string | undefined;
    let completed = false;

    for (let pageNumber = 0; pageNumber < requests.length; pageNumber++) {
      const page = await getMessages(
        appEnv,
        cursor === undefined ? { requests } : { cursor },
        [seeded.conversation.namespace],
        OWNER_DB_USER_ID,
      );
      expect(page.results.length).toBeGreaterThan(0);
      expect(page.results.length).toBeLessThanOrEqual(requests.length);
      expect(page.used_serialized_bytes).toBeLessThanOrEqual(page.max_serialized_bytes);
      for (const entry of page.results) {
        expect(byRequestIndex.has(entry.request_index)).toBe(false);
        byRequestIndex.set(entry.request_index, entry);
      }
      if (page.next_cursor === null) {
        completed = true;
        break;
      }
      cursor = page.next_cursor;
    }

    expect(completed).toBe(true);
    expect([...byRequestIndex.keys()]).toEqual(Array.from({ length: 100 }, (_, index) => index));
    expect([...byRequestIndex.values()].every((entry) => entry.status === "ok")).toBe(true);
  });

  it("pages whole results, signs cursors, and isolates errors", async () => {
    const successText = "s".repeat(1_800);
    const seeded = await seed(`messages-${crypto.randomUUID()}`, ["x".repeat(12_000), successText]);
    const requests = [
      {
        conversation_id: seeded.conversation.id,
        source_node_id: `${seeded.conversation.id}-node-0`,
      },
      {
        conversation_id: seeded.conversation.id,
        source_node_id: `${seeded.conversation.id}-node-1`,
      },
      { conversation_id: seeded.conversation.id, source_node_id: "missing" },
      {
        conversation_id: seeded.conversation.id,
        source_node_id: `${seeded.conversation.id}-node-1`,
      },
      {
        conversation_id: seeded.conversation.id,
        source_node_id: `${seeded.conversation.id}-node-1`,
      },
    ];
    const maxSerializedBytes = 4096;
    const first = await getMessages(
      appEnv,
      { requests, max_serialized_bytes: maxSerializedBytes },
      [seeded.conversation.namespace],
      OWNER_DB_USER_ID,
    );
    expect(first.results[0]?.status).toBe("oversized");
    expect(
      first.results[0]?.oversized_message && "text" in first.results[0].oversized_message,
    ).toBe(false);
    expect(first.next_cursor).toBeTruthy();
    expect(first.used_serialized_bytes).toBeLessThanOrEqual(maxSerializedBytes);

    await expect(
      getMessages(
        appEnv,
        { cursor: `${first.next_cursor}tampered` },
        [seeded.conversation.namespace],
        OWNER_DB_USER_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const byRequestIndex = new Map<number, ExactMessageResult>();
    let page = first;
    let completed = false;
    for (let pageNumber = 0; pageNumber < requests.length; pageNumber++) {
      expect(page.results.length).toBeGreaterThan(0);
      expect(page.results.length).toBeLessThanOrEqual(requests.length);
      expect(page.used_serialized_bytes).toBeLessThanOrEqual(maxSerializedBytes);
      for (const entry of page.results) {
        expect(byRequestIndex.has(entry.request_index)).toBe(false);
        byRequestIndex.set(entry.request_index, entry);
      }
      if (page.next_cursor === null) {
        completed = true;
        break;
      }
      page = await getMessages(
        appEnv,
        { cursor: page.next_cursor, max_serialized_bytes: maxSerializedBytes },
        [seeded.conversation.namespace],
        OWNER_DB_USER_ID,
      );
    }

    expect(completed).toBe(true);
    expect([...byRequestIndex.keys()]).toEqual(
      Array.from({ length: requests.length }, (_, index) => index),
    );
    expect([...byRequestIndex.values()].map((entry) => entry.status)).toEqual([
      "oversized",
      "ok",
      "error",
      "ok",
      "ok",
    ]);
    const oversized = byRequestIndex.get(0);
    expect(oversized?.oversized_message && "text" in oversized.oversized_message).toBe(false);
    expect(byRequestIndex.get(1)?.message?.text).toBe(successText);
    expect(byRequestIndex.get(2)?.error?.code).toBe("NOT_FOUND");
  });

  it("does not reveal foreign conversations or keys", async () => {
    const namespace = `messages-${crypto.randomUUID()}`;
    const foreign = await getOrCreateUser(env, `foreign-${crypto.randomUUID()}@example.com`);
    await grantNamespace(env, foreign.id, namespace);
    const conversation = fixture(namespace, crypto.randomUUID(), ["private"], true);
    await writeCanonicalConversation(env, conversation, null, null, foreign.id);
    const result = await getMessages(
      appEnv,
      { requests: [{ conversation_id: conversation.id, message_key: "state.relationship" }] },
      [namespace],
      OWNER_DB_USER_ID,
    );
    expect(result.results[0]?.status).toBe("error");
    expect(result.results[0]?.error?.code).toBe("NOT_FOUND");
  });
});
