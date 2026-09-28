import { AppError } from "./errors";

/**
 * Single runtime capability contract shared by the MCP and HTTP transports
 * (ADR 0037). This module is a leaf: it imports nothing from the application
 * graph, and the modules that enforce a limit import the limit from here. The
 * `memory_get_capabilities` MCP tool serializes `memoryCapabilities()`.
 */

export const CAPABILITIES_PROTOCOL_VERSION = "1";
export const CAPABILITIES_VERSION = "2026-09-28";

// Transport budgets.
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_INLINE_JSON_WRITE_BYTES = 1024 * 1024;
export const MAX_DIRECT_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_MULTIPART_PART_BYTES = 16 * 1024 * 1024;

// Response budgets.
export const COMPACT_RESPONSE_BYTES = 48 * 1024;
export const RECOMMENDED_TOOL_OUTPUT_BYTES = COMPACT_RESPONSE_BYTES;
export const MUTATION_RECEIPT_MAX_SERIALIZED_BYTES = 48 * 1024;
export const BATCH_DEFAULT_SERIALIZED_BYTES = 32 * 1024;
export const BATCH_MIN_SERIALIZED_BYTES = 4 * 1024;
export const BATCH_MAX_SERIALIZED_BYTES = COMPACT_RESPONSE_BYTES;

// Context compilation budgets.
export const MAX_SERIALIZED_BYTES_LIMIT = 49152;
export const MAX_FOLLOW_TARGETS_LIMIT = 20;

// Message and envelope limits.
export const MAX_MESSAGE_CONTENT_CHARS = 1_000_000;
export const MAX_MESSAGE_ROLE_CHARS = 40;
export const MAX_TITLE_CHARS = 500;
export const MAX_NAMESPACE_CHARS = 100;
export const MAX_IDEMPOTENCY_KEY_CHARS = 128;
export const MAX_TAGS_PER_CONVERSATION = 20;
export const MAX_TAG_CHARS = 64;
export const MAX_STORE_MESSAGES = 1000;
export const MAX_REPLACE_MESSAGES = 1000;
export const MAX_APPEND_MESSAGES = 100;

// Read and paging limits.
export const MAX_PAGE_ITEMS = 100;
export const DEFAULT_PAGE_ITEMS = 20;
export const MAX_SEARCH_ITEMS = 20;
export const DEFAULT_SEARCH_ITEMS = 8;
export const MAX_SEARCH_QUERY_CHARS = 2000;
export const MAX_CHUNK_CONTEXT_MESSAGES = 10;
export const MAX_BATCH_ITEMS = 20;
export const MAX_BATCH_CURSOR_CHARS = 16 * 1024;
export const MAX_RESOLVE_ITEMS = 20;
export const MAX_COPY_ITEMS = 20;
export const MAX_DELETE_ITEMS = 100;

// Context compilation item limits.
export const MAX_CONTEXT_REQUIRED_ITEMS = 20;
export const MAX_CONTEXT_RETRIEVE_QUERIES = 8;
export const MAX_CONTEXT_TAIL_MESSAGES = 100;
export const MAX_CONTEXT_PRIORITY = 100;

export const BATCH_RESPONSE_BYTES = {
  default: BATCH_DEFAULT_SERIALIZED_BYTES,
  min: BATCH_MIN_SERIALIZED_BYTES,
  max: BATCH_MAX_SERIALIZED_BYTES,
} as const;

export type RequestTooLargeDetails = {
  code: "REQUEST_TOO_LARGE";
  request_bytes: number;
  max_request_bytes: number;
  suggested_max_items?: number;
};

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Conservative item suggestion: floor of proportional scaling, never rounded up.
 * Callers must not treat it as a guarantee because message sizes vary.
 */
export function suggestedMaxItems(
  requestBytes: number,
  maxRequestBytes: number,
  itemCount: number,
): number | undefined {
  if (!Number.isFinite(itemCount) || itemCount < 1 || requestBytes <= 0) return undefined;
  return Math.max(1, Math.floor((itemCount * maxRequestBytes) / requestBytes));
}

export function requestTooLargeDetails(
  requestBytes: number,
  maxRequestBytes: number,
  itemCount?: number,
): RequestTooLargeDetails {
  const suggestion =
    itemCount === undefined
      ? undefined
      : suggestedMaxItems(requestBytes, maxRequestBytes, itemCount);
  return {
    code: "REQUEST_TOO_LARGE",
    request_bytes: requestBytes,
    max_request_bytes: maxRequestBytes,
    ...(suggestion === undefined ? {} : { suggested_max_items: suggestion }),
  };
}

export function requestTooLargeError(
  message: string,
  requestBytes: number,
  maxRequestBytes: number,
  itemCount?: number,
): AppError {
  return new AppError(
    "REQUEST_TOO_LARGE",
    message,
    413,
    false,
    requestTooLargeDetails(requestBytes, maxRequestBytes, itemCount),
  );
}

/**
 * Validates the complete serialized inline JSON request, including roles,
 * timestamps, keys, tags, and envelope, before any canonical work begins.
 * Returns the measurement so callers can disclose it.
 */
export function assertInlineWriteBudget(
  serialized: string,
  itemCount: number,
  maxRequestBytes = MAX_INLINE_JSON_WRITE_BYTES,
): number {
  const requestBytes = utf8ByteLength(serialized);
  if (requestBytes > maxRequestBytes) {
    throw requestTooLargeError(
      `Serialized request is ${requestBytes} bytes; inline JSON writes are limited to ${maxRequestBytes} bytes.`,
      requestBytes,
      maxRequestBytes,
      itemCount,
    );
  }
  return requestBytes;
}

export interface CapabilityToolLimits {
  max_items?: number;
  default_items?: number;
  max_request_bytes?: number;
  max_response_bytes?: number;
  default_response_bytes?: number;
  max_tail_messages?: number;
  supports_cursor?: boolean;
  supports_verify?: boolean;
}

export interface MemoryCapabilities {
  protocol_version: string;
  capabilities_version: string;
  limits: {
    max_tool_output_bytes: number;
    recommended_tool_output_bytes: number;
    max_inline_json_write_bytes: number;
    max_direct_import_bytes: number;
    max_multipart_part_bytes: number;
    max_message_content_chars: number;
    max_receipt_bytes: number;
  };
  tools: Record<string, CapabilityToolLimits>;
  features: {
    revision_pinning: boolean;
    verified_writes: boolean;
    cursor_reads: boolean;
    message_keys: boolean;
    atomic_multi_conversation_commit: boolean;
  };
}

export function memoryCapabilities(): MemoryCapabilities {
  return {
    protocol_version: CAPABILITIES_PROTOCOL_VERSION,
    capabilities_version: CAPABILITIES_VERSION,
    limits: {
      max_tool_output_bytes: MAX_TOOL_OUTPUT_BYTES,
      recommended_tool_output_bytes: RECOMMENDED_TOOL_OUTPUT_BYTES,
      max_inline_json_write_bytes: MAX_INLINE_JSON_WRITE_BYTES,
      max_direct_import_bytes: MAX_DIRECT_IMPORT_BYTES,
      max_multipart_part_bytes: MAX_MULTIPART_PART_BYTES,
      max_message_content_chars: MAX_MESSAGE_CONTENT_CHARS,
      max_receipt_bytes: MUTATION_RECEIPT_MAX_SERIALIZED_BYTES,
    },
    tools: {
      memory_search: { max_items: MAX_SEARCH_ITEMS, default_items: DEFAULT_SEARCH_ITEMS },
      memory_get_context: { max_items: MAX_CHUNK_CONTEXT_MESSAGES },
      memory_get_conversation: { max_items: MAX_PAGE_ITEMS, default_items: DEFAULT_PAGE_ITEMS },
      memory_get_conversations: {
        max_items: MAX_BATCH_ITEMS,
        default_response_bytes: BATCH_RESPONSE_BYTES.default,
        max_response_bytes: BATCH_RESPONSE_BYTES.max,
        supports_cursor: true,
      },
      memory_list_conversations: { max_items: MAX_PAGE_ITEMS, default_items: DEFAULT_PAGE_ITEMS },
      memory_list_revisions: {
        max_items: MAX_PAGE_ITEMS,
        default_items: DEFAULT_PAGE_ITEMS,
        supports_cursor: true,
      },
      memory_resolve_conversations: { max_items: MAX_RESOLVE_ITEMS },
      memory_build_context: {
        max_items: MAX_CONTEXT_REQUIRED_ITEMS,
        max_tail_messages: MAX_CONTEXT_TAIL_MESSAGES,
        max_response_bytes: MAX_SERIALIZED_BYTES_LIMIT,
        default_response_bytes: BATCH_RESPONSE_BYTES.default,
      },
      memory_store: {
        max_items: MAX_STORE_MESSAGES,
        max_request_bytes: MAX_INLINE_JSON_WRITE_BYTES,
        supports_verify: true,
      },
      memory_append: {
        max_items: MAX_APPEND_MESSAGES,
        max_request_bytes: MAX_INLINE_JSON_WRITE_BYTES,
        supports_verify: true,
      },
      memory_replace: {
        max_items: MAX_REPLACE_MESSAGES,
        max_request_bytes: MAX_INLINE_JSON_WRITE_BYTES,
        supports_verify: true,
      },
      memory_restore_revision: { supports_verify: true },
      memory_copy_conversations: { max_items: MAX_COPY_ITEMS, supports_verify: true },
      memory_update_tags: { max_items: MAX_TAGS_PER_CONVERSATION },
      memory_delete_conversations: { max_items: MAX_DELETE_ITEMS },
    },
    features: {
      revision_pinning: true,
      verified_writes: true,
      cursor_reads: true,
      message_keys: false,
      atomic_multi_conversation_commit: false,
    },
  };
}
