import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BATCH_RESPONSE_BYTES,
  MAX_APPEND_MESSAGES,
  MAX_DIRECT_IMPORT_BYTES,
  MAX_INLINE_JSON_WRITE_BYTES,
  MAX_MESSAGE_CONTENT_CHARS,
  MAX_MULTIPART_PART_BYTES,
  MAX_STORE_MESSAGES,
  MAX_TOOL_OUTPUT_BYTES,
  MUTATION_RECEIPT_MAX_SERIALIZED_BYTES,
  RECOMMENDED_TOOL_OUTPUT_BYTES,
} from "../src/limits";

// ADR 0037 keeps src/limits.ts as the single capability contract. These documents quote its
// values, so a constant changed without the matching documentation edit fails here.
const documents = {
  "README.md": readFileSync("README.md", "utf8"),
  "docs/mcp.md": readFileSync("docs/mcp.md", "utf8"),
} as const;

type DocumentName = keyof typeof documents;

type Claim = {
  file: DocumentName;
  claim: string;
  pattern: RegExp;
  expected: number[];
};

const claims: Claim[] = [
  {
    file: "README.md",
    claim: "64 KiB MCP tool guard",
    pattern: /below the ([\d,]+) KiB MCP tool guard/u,
    expected: [MAX_TOOL_OUTPUT_BYTES / 1024],
  },
  {
    file: "README.md",
    claim: "48 KiB mutation receipt maximum",
    pattern: /documented safe maximum of ([\d,]+) bytes \((\d+) KiB\)/u,
    expected: [MUTATION_RECEIPT_MAX_SERIALIZED_BYTES, MUTATION_RECEIPT_MAX_SERIALIZED_BYTES / 1024],
  },
  {
    file: "README.md",
    claim: "1 MiB inline write ceiling",
    pattern: /on both\s+transports are limited to ([\d,]+) bytes \((\d+) MiB\)/u,
    expected: [MAX_INLINE_JSON_WRITE_BYTES, MAX_INLINE_JSON_WRITE_BYTES / (1024 * 1024)],
  },
  {
    file: "README.md",
    claim: "16 MiB direct import ceiling",
    pattern: /Files up to (\d+) MiB use direct streaming upload/u,
    expected: [MAX_DIRECT_IMPORT_BYTES / (1024 * 1024)],
  },
  {
    file: "README.md",
    claim: "16 MiB multipart part ceiling",
    pattern: /use (\d+) MiB R2 multipart parts/u,
    expected: [MAX_MULTIPART_PART_BYTES / (1024 * 1024)],
  },
  {
    file: "docs/mcp.md",
    claim: "64 KiB serialized tool output guard",
    pattern: /caps serialized tool output at ([\d,]+) KiB/u,
    expected: [MAX_TOOL_OUTPUT_BYTES / 1024],
  },
  {
    file: "docs/mcp.md",
    claim: "48 KiB recommended response budget",
    pattern: /`recommended_tool_output_bytes` \(([\d,]+) bytes, (\d+) KiB\)/u,
    expected: [RECOMMENDED_TOOL_OUTPUT_BYTES, RECOMMENDED_TOOL_OUTPUT_BYTES / 1024],
  },
  {
    file: "docs/mcp.md",
    claim: "1 MiB inline write ceiling",
    pattern: /`max_inline_json_write_bytes` \(([\d,]+) bytes, (\d+) MiB\)/u,
    expected: [MAX_INLINE_JSON_WRITE_BYTES, MAX_INLINE_JSON_WRITE_BYTES / (1024 * 1024)],
  },
  {
    file: "docs/mcp.md",
    claim: "16 MiB direct import ceiling",
    pattern: /`max_direct_import_bytes` \(([\d,]+) bytes, (\d+) MiB\)/u,
    expected: [MAX_DIRECT_IMPORT_BYTES, MAX_DIRECT_IMPORT_BYTES / (1024 * 1024)],
  },
  {
    file: "docs/mcp.md",
    claim: "16 MiB multipart part ceiling",
    pattern: /`max_multipart_part_bytes` \(([\d,]+) bytes, (\d+) MiB\)/u,
    expected: [MAX_MULTIPART_PART_BYTES, MAX_MULTIPART_PART_BYTES / (1024 * 1024)],
  },
  {
    file: "docs/mcp.md",
    claim: "capability example max_tool_output_bytes",
    pattern: /"max_tool_output_bytes": ([\d,]+)/u,
    expected: [MAX_TOOL_OUTPUT_BYTES],
  },
  {
    file: "docs/mcp.md",
    claim: "capability example recommended_tool_output_bytes",
    pattern: /"recommended_tool_output_bytes": ([\d,]+)/u,
    expected: [RECOMMENDED_TOOL_OUTPUT_BYTES],
  },
  {
    file: "docs/mcp.md",
    claim: "capability example max_inline_json_write_bytes",
    pattern: /"max_inline_json_write_bytes": ([\d,]+)/u,
    expected: [MAX_INLINE_JSON_WRITE_BYTES],
  },
  {
    file: "docs/mcp.md",
    claim: "capability example max_direct_import_bytes",
    pattern: /"max_direct_import_bytes": ([\d,]+)/u,
    expected: [MAX_DIRECT_IMPORT_BYTES],
  },
  {
    file: "docs/mcp.md",
    claim: "capability example max_multipart_part_bytes",
    pattern: /"max_multipart_part_bytes": ([\d,]+)/u,
    expected: [MAX_MULTIPART_PART_BYTES],
  },
  {
    file: "docs/mcp.md",
    claim: "capability example max_message_content_chars",
    pattern: /"max_message_content_chars": ([\d,]+)/u,
    expected: [MAX_MESSAGE_CONTENT_CHARS],
  },
  {
    file: "docs/mcp.md",
    claim: "capability example max_receipt_bytes",
    pattern: /"max_receipt_bytes": ([\d,]+)/u,
    expected: [MUTATION_RECEIPT_MAX_SERIALIZED_BYTES],
  },
  {
    file: "docs/mcp.md",
    claim: "32 KiB batch default with min and max",
    pattern: /from ([\d,]+) through ([\d,]+)\.\s+It defaults to\s+([\d,]+)\./u,
    expected: [BATCH_RESPONSE_BYTES.min, BATCH_RESPONSE_BYTES.max, BATCH_RESPONSE_BYTES.default],
  },
  {
    file: "docs/mcp.md",
    claim: "1000 store message maximum",
    pattern: /`memory_store`[^\n]*?1–([\d,]+) messages/u,
    expected: [MAX_STORE_MESSAGES],
  },
  {
    file: "docs/mcp.md",
    claim: "100 append message maximum",
    pattern: /"memory_append": \{\s+"max_items": ([\d,]+)/u,
    expected: [MAX_APPEND_MESSAGES],
  },
];

// A capture may hold a numeric expression such as `16 * 1024 * 1024`, not just a literal.
function numericValue(raw: string): number {
  return raw
    .replaceAll(",", "")
    .split("*")
    .reduce((product, factor) => product * Number(factor), 1);
}

function documentedNumbers(file: DocumentName, claim: string, pattern: RegExp): number[] {
  const match = pattern.exec(documents[file]);
  if (match === null) {
    throw new Error(`${file} no longer quotes the ${claim} value (${String(pattern)})`);
  }
  return match.slice(1).map(numericValue);
}

describe("Capability documentation drift", () => {
  it("names the memory_get_capabilities tool", () => {
    expect(documents["docs/mcp.md"]).toContain("memory_get_capabilities");
  });

  it.each(claims)("$file quotes the $claim value", ({ file, claim, pattern, expected }) => {
    const actual = documentedNumbers(file, claim, pattern);
    expect(actual, `${file} uses a different number of values for ${claim}`).toHaveLength(
      expected.length,
    );
    expected.forEach((value, index) => {
      const actualValue = String(actual[index]);
      const message =
        `${file} documents ${actualValue} for ${claim}; ` +
        `src/limits.ts exports ${String(value)}`;
      expect(actual[index], message).toBe(value);
    });
  });
});
