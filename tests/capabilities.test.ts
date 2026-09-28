import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors";
import {
  assertInlineWriteBudget,
  BATCH_RESPONSE_BYTES,
  CAPABILITIES_PROTOCOL_VERSION,
  CAPABILITIES_VERSION,
  MAX_APPEND_MESSAGES,
  MAX_BATCH_ITEMS,
  MAX_CONTEXT_TAIL_MESSAGES,
  MAX_DIRECT_IMPORT_BYTES,
  MAX_INLINE_JSON_WRITE_BYTES,
  MAX_MESSAGE_CONTENT_CHARS,
  MAX_MULTIPART_PART_BYTES,
  MAX_REPLACE_MESSAGES,
  MAX_SERIALIZED_BYTES_LIMIT,
  MAX_STORE_MESSAGES,
  MAX_TOOL_OUTPUT_BYTES,
  MUTATION_RECEIPT_MAX_SERIALIZED_BYTES,
  memoryCapabilities,
  RECOMMENDED_TOOL_OUTPUT_BYTES,
  requestTooLargeDetails,
  suggestedMaxItems,
  utf8ByteLength,
} from "../src/limits";

function captureBudgetError(
  serialized: string,
  itemCount: number,
  maxRequestBytes?: number,
): AppError {
  try {
    assertInlineWriteBudget(serialized, itemCount, maxRequestBytes);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected assertInlineWriteBudget to throw");
}

describe("utf8ByteLength", () => {
  it("asserts exact UTF-8 byte counts for ASCII, multibyte, and astral strings", () => {
    const cases = [
      ["", 0],
      ["plain ascii", 11],
      ["é", 2],
      ["中", 3],
      ["👍", 4],
      ["café 中文 👍", 17],
      ["aé中👍z", 11],
    ] as const;
    for (const [text, expected] of cases) {
      expect(utf8ByteLength(text)).toBe(expected);
    }
  });

  it("is strictly greater than String.length for multibyte input and equal for ASCII", () => {
    for (const text of ["é", "中", "👍", "café 中文 👍"]) {
      expect(utf8ByteLength(text)).toBeGreaterThan(text.length);
    }
    for (const text of ["", "plain ascii only"]) {
      expect(utf8ByteLength(text)).toBe(text.length);
    }
  });
});

describe("suggestedMaxItems", () => {
  const max = MAX_INLINE_JSON_WRITE_BYTES;

  it("floors the proportional estimate and never rounds up", () => {
    // 4 items in a request 3x over budget: 400/300 = 1.33 -> 1.
    expect(suggestedMaxItems(300, 100, 4)).toBe(1);
  });

  it("scales proportionally down from the item count", () => {
    expect(suggestedMaxItems(max, max, 4)).toBe(4);
    expect(suggestedMaxItems(2 * max, max, 4)).toBe(2);
  });

  it("clamps to at least 1 when the estimate falls below one item", () => {
    expect(suggestedMaxItems(4 * max, max, 4)).toBe(1);
    expect(suggestedMaxItems(8 * max, max, 4)).toBe(1);
  });

  it("returns undefined for itemCount < 1 or requestBytes <= 0", () => {
    expect(suggestedMaxItems(1000, 100, 0)).toBeUndefined();
    expect(suggestedMaxItems(1000, 100, -1)).toBeUndefined();
    expect(suggestedMaxItems(1000, 100, Number.NaN)).toBeUndefined();
    expect(suggestedMaxItems(0, 100, 4)).toBeUndefined();
    expect(suggestedMaxItems(-10, 100, 4)).toBeUndefined();
  });
});

describe("requestTooLargeDetails", () => {
  it("has exactly code/request_bytes/max_request_bytes without an item count", () => {
    const details = requestTooLargeDetails(2048, 1024);
    expect(Object.keys(details).sort()).toEqual(["code", "max_request_bytes", "request_bytes"]);
    expect(details).toEqual({
      code: "REQUEST_TOO_LARGE",
      request_bytes: 2048,
      max_request_bytes: 1024,
    });
  });

  it("only adds suggested_max_items when an item count is supplied", () => {
    const details = requestTooLargeDetails(200, 100, 4);
    expect(Object.keys(details).sort()).toEqual([
      "code",
      "max_request_bytes",
      "request_bytes",
      "suggested_max_items",
    ]);
    expect(details.suggested_max_items).toBe(2);

    const unusable = requestTooLargeDetails(0, 100, 4);
    expect(Object.keys(unusable).sort()).toEqual(["code", "max_request_bytes", "request_bytes"]);
  });
});

describe("assertInlineWriteBudget", () => {
  it("passes a request of exactly MAX_INLINE_JSON_WRITE_BYTES UTF-8 bytes", () => {
    const serialized = "a".repeat(MAX_INLINE_JSON_WRITE_BYTES);
    expect(utf8ByteLength(serialized)).toBe(MAX_INLINE_JSON_WRITE_BYTES);
    expect(assertInlineWriteBudget(serialized, 3)).toBe(MAX_INLINE_JSON_WRITE_BYTES);
  });

  it("returns the measured byte count for a multibyte payload", () => {
    const serialized = JSON.stringify({ messages: [{ content: "héllo 中文 👍" }] });
    expect(assertInlineWriteBudget(serialized, 1)).toBe(utf8ByteLength(serialized));
  });

  it("throws REQUEST_TOO_LARGE one byte over the default ceiling", () => {
    const serialized = "a".repeat(MAX_INLINE_JSON_WRITE_BYTES + 1);
    const error = captureBudgetError(serialized, 3);
    expect(error.code).toBe("REQUEST_TOO_LARGE");
    expect(error.status).toBe(413);
    expect(error.retryable).toBe(false);
    expect(error.details.request_bytes).toBe(MAX_INLINE_JSON_WRITE_BYTES + 1);
    expect(error.details.max_request_bytes).toBe(MAX_INLINE_JSON_WRITE_BYTES);
    const suggested = error.details.suggested_max_items;
    expect(typeof suggested).toBe("number");
    expect(Number.isInteger(suggested)).toBe(true);
    expect(Number(suggested)).toBeGreaterThanOrEqual(1);
  });

  it("counts envelope, roles, timestamps, tags, and keys beyond message bodies", () => {
    const bodies = ["hello", "world"];
    const serialized = JSON.stringify({
      idempotency_key: "idem-0001",
      tags: ["alpha", "beta"],
      messages: [
        {
          key: "m1",
          role: "user",
          created_at: "2026-09-28T00:00:00.000Z",
          content: bodies[0],
        },
        {
          key: "m2",
          role: "assistant",
          created_at: "2026-09-28T00:00:01.000Z",
          content: bodies[1],
        },
      ],
    });
    expect(utf8ByteLength(serialized)).toBeGreaterThan(utf8ByteLength(bodies.join("")));
  });

  it("honours an explicit lower maxRequestBytes", () => {
    expect(assertInlineWriteBudget("1234", 2, 4)).toBe(4);

    const error = captureBudgetError("x".repeat(10), 2, 4);
    expect(error.details.request_bytes).toBe(10);
    expect(error.details.max_request_bytes).toBe(4);
    expect(error.details.suggested_max_items).toBe(1);
  });
});

describe("memoryCapabilities", () => {
  const caps = memoryCapabilities();

  it("derives every limit from its enforcing constant", () => {
    expect(caps.protocol_version).toBe(CAPABILITIES_PROTOCOL_VERSION);
    expect(caps.capabilities_version).toBe(CAPABILITIES_VERSION);
    expect(caps.limits.max_tool_output_bytes).toBe(MAX_TOOL_OUTPUT_BYTES);
    expect(caps.limits.recommended_tool_output_bytes).toBe(RECOMMENDED_TOOL_OUTPUT_BYTES);
    expect(caps.limits.max_inline_json_write_bytes).toBe(MAX_INLINE_JSON_WRITE_BYTES);
    expect(caps.limits.max_direct_import_bytes).toBe(MAX_DIRECT_IMPORT_BYTES);
    expect(caps.limits.max_multipart_part_bytes).toBe(MAX_MULTIPART_PART_BYTES);
    expect(caps.limits.max_message_content_chars).toBe(MAX_MESSAGE_CONTENT_CHARS);
    expect(caps.limits.max_receipt_bytes).toBe(MUTATION_RECEIPT_MAX_SERIALIZED_BYTES);
  });

  it("reports the inline write tools with their enforced item caps", () => {
    expect(MAX_STORE_MESSAGES).toBe(1000);
    expect(MAX_APPEND_MESSAGES).toBe(100);
    expect(MAX_REPLACE_MESSAGES).toBe(1000);
    expect(caps.tools.memory_store).toEqual({
      max_items: MAX_STORE_MESSAGES,
      max_request_bytes: MAX_INLINE_JSON_WRITE_BYTES,
      supports_verify: true,
    });
    expect(caps.tools.memory_append).toEqual({
      max_items: MAX_APPEND_MESSAGES,
      max_request_bytes: MAX_INLINE_JSON_WRITE_BYTES,
      supports_verify: true,
    });
    expect(caps.tools.memory_replace).toEqual({
      max_items: MAX_REPLACE_MESSAGES,
      max_request_bytes: MAX_INLINE_JSON_WRITE_BYTES,
      supports_verify: true,
    });
  });

  it("reports cursor reads and byte budgets for batch and context tools", () => {
    expect(caps.tools.memory_get_conversations).toEqual({
      max_items: MAX_BATCH_ITEMS,
      default_response_bytes: BATCH_RESPONSE_BYTES.default,
      max_response_bytes: BATCH_RESPONSE_BYTES.max,
      supports_cursor: true,
    });
    expect(caps.tools.memory_build_context?.max_response_bytes).toBe(MAX_SERIALIZED_BYTES_LIMIT);
    expect(caps.tools.memory_build_context?.max_tail_messages).toBe(MAX_CONTEXT_TAIL_MESSAGES);
  });

  it("reports the feature flags exactly", () => {
    expect(caps.features).toEqual({
      revision_pinning: true,
      verified_writes: true,
      cursor_reads: true,
      message_keys: false,
      atomic_multi_conversation_commit: false,
    });
  });
});
