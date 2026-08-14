export type ErrorCode =
  | "VALIDATION"
  | "AUTHENTICATION"
  | "NOT_FOUND"
  | "IMPORT_CONFLICT"
  | "CANONICAL_STORAGE"
  | "DERIVED_INDEXING"
  | "RETRYABLE_INFRASTRUCTURE"
  | "PERMANENT_PARSER"
  | "DEGRADED_SEARCH";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 500,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorDetails(error: unknown): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "RETRYABLE_INFRASTRUCTURE",
    message: error instanceof Error ? error.message : "Unknown failure",
    retryable: true,
  };
}
