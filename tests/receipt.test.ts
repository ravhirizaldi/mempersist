import { describe, expect, it } from "vitest";
import { jsonBytes, type CompactPage } from "../src/retrieval";
import {
  fitMutationReceipt,
  MUTATION_RECEIPT_ERROR_MESSAGE_FLOOR,
  MUTATION_RECEIPT_ERROR_MESSAGE_LIMIT,
  MUTATION_RECEIPT_MAX_SERIALIZED_BYTES,
  type MutationReceiptItem,
  type MutationReceiptReadbackSelector,
} from "../src/writes";

const ERROR_CODE = "CANONICAL_STORAGE";

// Deterministic 64-char lowercase hex identifier, distinguishable per seed.
function hex64(seed: number): string {
  return seed.toString(16).padStart(2, "0").repeat(32).slice(0, 64);
}

function page(seed: number, text: string): CompactPage {
  return {
    conversation: {
      id: hex64(seed),
      revisionId: hex64(seed),
      title: "bounded",
      namespace: "test",
      tags: [],
    },
    messages: [{ sourceNodeId: hex64(seed), role: "user", createdAt: null, updatedAt: null, text }],
    offset: 0,
    nextOffset: null,
    total: 1,
    oversizedMessage: null,
  };
}

interface BuiltItem {
  item: MutationReceiptItem;
  conversationId: string;
  revisionId: string;
}

function copiedItem(index: number, inline?: CompactPage): BuiltItem {
  const conversationId = hex64(101 + index * 5);
  const revisionId = hex64(102 + index * 5);
  return {
    conversationId,
    revisionId,
    item: {
      request_index: index,
      status: "copied",
      conversation_id: conversationId,
      revision_id: revisionId,
      durable: true,
      indexing: { status: "queued", job_id: hex64(103 + index * 5) },
      verification: {
        status: "passed",
        revision_id: revisionId,
        checked_messages: 3,
        readback_available: true,
        ...(inline ? { readback: inline } : {}),
      },
      source_conversation_id: hex64(104 + index * 5),
      source_revision_id: hex64(105 + index * 5),
    },
  };
}

function failedItem(index: number, message: string): MutationReceiptItem {
  return {
    request_index: index,
    status: "failed",
    source_conversation_id: hex64(201 + index),
    error: { code: ERROR_CODE, message },
  };
}

function selector(index: number): MutationReceiptReadbackSelector {
  return {
    conversation_id: hex64(301 + index),
    revision_id: hex64(302 + index),
    offset: 0,
    limit: 20,
    branch: "active",
  };
}

interface WrapPayload {
  items: MutationReceiptItem[];
  readback_requests: MutationReceiptReadbackSelector[];
  omitted: string[];
}

interface BulkBody {
  results: MutationReceiptItem[];
  readback_requests?: MutationReceiptReadbackSelector[];
  omitted?: string[];
}

function bulkWrap(payload: WrapPayload): BulkBody {
  return {
    results: payload.items,
    ...(payload.readback_requests.length ? { readback_requests: payload.readback_requests } : {}),
    ...(payload.omitted.length ? { omitted: payload.omitted } : {}),
  };
}

type FlatBody = MutationReceiptItem & {
  readback_requests?: MutationReceiptReadbackSelector[];
  omitted?: string[];
};

function flatWrap(payload: WrapPayload): FlatBody {
  const first: MutationReceiptItem = payload.items[0] ?? {};
  return {
    ...first,
    ...(payload.readback_requests.length ? { readback_requests: payload.readback_requests } : {}),
    ...(payload.omitted.length ? { omitted: payload.omitted } : {}),
  };
}

function receipt(
  items: MutationReceiptItem[],
  readbackRequests: MutationReceiptReadbackSelector[] = [],
  maxSerializedBytes?: number,
) {
  return fitMutationReceipt({
    items,
    ...(readbackRequests.length ? { readbackRequests } : {}),
    wrap: bulkWrap,
    ...(maxSerializedBytes === undefined ? {} : { maxSerializedBytes }),
  });
}

function flatReceipt(
  items: MutationReceiptItem[],
  readbackRequests: MutationReceiptReadbackSelector[] = [],
  maxSerializedBytes?: number,
) {
  return fitMutationReceipt({
    items,
    ...(readbackRequests.length ? { readbackRequests } : {}),
    wrap: flatWrap,
    ...(maxSerializedBytes === undefined ? {} : { maxSerializedBytes }),
  });
}

// A copied item exercising every shedable field at once.
function richCopiedItem(index: number, textLength = 1200): MutationReceiptItem {
  const base = copiedItem(index, page(index, "x".repeat(textLength))).item;
  return {
    ...base,
    indexing: {
      status: "failed",
      job_id: hex64(400 + index),
      error: { code: "DERIVED_INDEXING", message: "indexing failed ".repeat(10), retryable: true },
    },
    verification: {
      status: "failed",
      revision_id: base.revision_id ?? hex64(index),
      checked_messages: 5,
      readback_available: true,
      readback: page(index, "x".repeat(textLength)),
      readback_error: { code: "RESPONSE_TOO_LARGE", message: "metadata too large", offset: 0 },
    },
    source_conversation_id: hex64(500 + index),
    source_revision_id: hex64(501 + index),
  };
}

describe("fitMutationReceipt", () => {
  it("accounts serialized bytes exactly and reports the documented ceiling", () => {
    const { item } = copiedItem(0, page(0, "hello receipt"));
    const result = flatReceipt([item]);

    expect(result.value.max_serialized_bytes).toBe(MUTATION_RECEIPT_MAX_SERIALIZED_BYTES);
    expect(result.maxBytes).toBe(MUTATION_RECEIPT_MAX_SERIALIZED_BYTES);
    expect(result.value.used_serialized_bytes).toBe(jsonBytes(result.value));
    expect(result.usedBytes).toBe(jsonBytes(result.value));
    expect(result.value.used_serialized_bytes).toBe(result.usedBytes);
    expect(result.usedBytes).toBeLessThanOrEqual(MUTATION_RECEIPT_MAX_SERIALIZED_BYTES);
    expect(result.omitted).toEqual([]);
  });

  it("keeps required fields within the ceiling for worst-case bulk receipts", () => {
    const copied = Array.from({ length: 10 }, (_, index) =>
      copiedItem(index, page(index, "x".repeat(400))),
    );
    const failed = Array.from({ length: 10 }, (_, index) =>
      failedItem(index + 10, "e".repeat(100 * 1024)),
    );
    const items: MutationReceiptItem[] = [];
    for (let index = 0; index < 10; index += 1) {
      items.push(copied[index]!.item, failed[index]!);
    }
    const result = receipt(
      items,
      Array.from({ length: 20 }, (_, index) => selector(index)),
    );

    const bytes = jsonBytes(result.value);
    expect(bytes).toBeLessThanOrEqual(MUTATION_RECEIPT_MAX_SERIALIZED_BYTES);
    expect(bytes).toBeLessThanOrEqual(result.value.max_serialized_bytes);
    expect(result.omitted).toContain("verification.readback");
    expect(result.value.results).toHaveLength(20);

    for (const item of result.value.results) {
      if (item.status === "copied") {
        const source = copied.find((entry) => entry.item.request_index === item.request_index);
        expect(source).toBeDefined();
        expect(item.conversation_id).toBe(source!.conversationId);
        expect(item.revision_id).toBe(source!.revisionId);
        expect(item.durable).toBe(true);
        expect(item.indexing?.status).toBe("queued");
        expect(item.verification?.readback_available).toBe(true);
      } else {
        expect(item.status).toBe("failed");
        expect(item.error?.code).toBe(ERROR_CODE);
      }
    }
  });

  it("caps oversized error metadata at the limit, then the floor, then drops it", () => {
    const huge = "e".repeat(100 * 1024);

    const roomy = flatReceipt([failedItem(0, huge)]);
    const retained = roomy.value.error!.message;
    expect(retained.length).toBeLessThanOrEqual(MUTATION_RECEIPT_ERROR_MESSAGE_LIMIT);
    expect(retained).toBe("e".repeat(MUTATION_RECEIPT_ERROR_MESSAGE_FLOOR));
    expect(roomy.value.error!.code).toBe(ERROR_CODE);
    expect(roomy.omitted).toContain("error.message");

    const small = flatReceipt([failedItem(0, "m".repeat(150))]);
    expect(small.value.error!.message.length).toBeLessThanOrEqual(
      MUTATION_RECEIPT_ERROR_MESSAGE_LIMIT,
    );
    expect(small.value.error!.message).toBe("m".repeat(150));

    const forced = flatReceipt([failedItem(0, huge)], [], 1);
    const item = forced.value;
    expect(item.error!.code).toBe(ERROR_CODE);
    expect("message" in item.error!).toBe(false);
    expect(forced.omitted).toContain("error.message");
  });

  it("sheds fields in the documented ladder order without touching required paths", () => {
    const order = [
      "verification.readback",
      "readback_requests",
      "verification.readback_error",
      "verification.checked_messages",
      "indexing.error",
      "indexing.job_id",
      "source_revision_id",
      "source_conversation_id",
      "error.message",
    ];
    const required = [
      "request_index",
      "status",
      "conversation_id",
      "previous_revision_id",
      "revision_id",
      "durable",
      "indexing.status",
      "verification.status",
      "verification.revision_id",
      "verification.readback_available",
      "error.code",
    ];

    const items: MutationReceiptItem[] = [];
    for (let index = 0; index < 6; index += 1) items.push(richCopiedItem(index));
    for (let index = 0; index < 6; index += 1) items.push(failedItem(index + 6, "e".repeat(300)));

    const result = receipt(
      items,
      Array.from({ length: 6 }, (_, index) => selector(index)),
      1024,
    );

    expect(result.omitted.length).toBeGreaterThan(0);
    expect(new Set(result.omitted).size).toBe(result.omitted.length);
    expect(result.omitted).toEqual(order);

    const ladderIndexes = result.omitted.map((path) => order.indexOf(path));
    expect(ladderIndexes.every((index) => index >= 0)).toBe(true);
    for (let index = 1; index < ladderIndexes.length; index += 1) {
      expect(ladderIndexes[index]!).toBeGreaterThan(ladderIndexes[index - 1]!);
    }
    expect(result.omitted.filter((path) => required.includes(path))).toEqual([]);
  });

  it("greedily keeps inline readback when it fits and sheds it when it does not", () => {
    const roomy = flatReceipt([copiedItem(0, page(0, "tiny page")).item], [selector(0)]);
    expect(roomy.omitted).toEqual([]);
    expect(roomy.value.verification?.readback).toBeDefined();
    expect(roomy.value.verification?.readback_available).toBe(true);

    const tight = flatReceipt([copiedItem(0, page(0, "y".repeat(4000))).item], [], 1024);
    expect(tight.value.verification?.readback).toBeUndefined();
    expect(tight.value.verification?.readback_available).toBe(true);
    expect(tight.omitted).toContain("verification.readback");
  });

  it("measures multi-byte content in UTF-8 bytes rather than characters", () => {
    const multibyte = "雨🌙".repeat(40);
    const result = receipt([
      copiedItem(0, page(0, multibyte)).item,
      copiedItem(1, page(1, multibyte)).item,
      failedItem(2, "错".repeat(300)),
    ]);

    expect(result.value.used_serialized_bytes).toBe(jsonBytes(result.value));
    expect(result.value.used_serialized_bytes).toBeGreaterThan(JSON.stringify(result.value).length);
    expect(result.value.used_serialized_bytes).toBeLessThanOrEqual(
      result.value.max_serialized_bytes,
    );
  });

  it("clamps the ceiling to the documented bound on both ends", () => {
    const floor = flatReceipt([copiedItem(0).item], [], 1);
    expect(floor.value.max_serialized_bytes).toBe(1);
    expect(floor.maxBytes).toBe(1);
    expect(floor.value.conversation_id).toBeDefined();
    expect(floor.value.revision_id).toBeDefined();
    expect(floor.value.durable).toBe(true);
    expect(floor.value.indexing?.status).toBe("queued");

    const ceiling = flatReceipt([copiedItem(0).item], [], 10 * 1024 * 1024);
    expect(ceiling.value.max_serialized_bytes).toBe(MUTATION_RECEIPT_MAX_SERIALIZED_BYTES);
    expect(ceiling.maxBytes).toBe(MUTATION_RECEIPT_MAX_SERIALIZED_BYTES);
    expect(ceiling.omitted).toEqual([]);
  });

  it("never mutates the caller's items or readback selectors", () => {
    const items: MutationReceiptItem[] = [];
    for (let index = 0; index < 6; index += 1) items.push(richCopiedItem(index));
    for (let index = 0; index < 6; index += 1) items.push(failedItem(index + 6, "e".repeat(2000)));
    const selectors = Array.from({ length: 6 }, (_, index) => selector(index));
    const itemsBefore = JSON.stringify(items);
    const selectorsBefore = JSON.stringify(selectors);

    const result = receipt(items, selectors, 1024);

    expect(result.omitted.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).toBe(itemsBefore);
    expect(JSON.stringify(selectors)).toBe(selectorsBefore);
  });

  it("drops readback_requests wholesale as its own ladder rung", () => {
    const selectors = Array.from({ length: 12 }, (_, index) => selector(index));

    const roomy = flatReceipt([copiedItem(0).item], selectors);
    expect(roomy.value.readback_requests).toHaveLength(selectors.length);
    expect(roomy.omitted).toEqual([]);

    const tight = flatReceipt([copiedItem(0).item], selectors, 1024);
    expect("readback_requests" in tight.value).toBe(false);
    expect(tight.omitted).toContain("readback_requests");
  });
});
