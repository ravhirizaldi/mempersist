import { AppError } from "./errors";

/** Streams complete values from a top-level JSON array without buffering the whole export. */
export async function* streamJsonArray(
  stream: ReadableStream<unknown>,
  maxItemBytes = 32 * 1024 * 1024,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let started = false;
  let finished = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let item = "";
  let itemBytes = 0;
  const encoder = new TextEncoder();

  const feed = function* (text: string): Generator<string> {
    for (const char of text) {
      if (!started) {
        if (/\s/u.test(char)) continue;
        if (char !== "[")
          throw new AppError("PERMANENT_PARSER", "Expected a top-level JSON array", 422);
        started = true;
        continue;
      }
      if (finished) {
        if (!/\s/u.test(char)) throw new AppError("PERMANENT_PARSER", "Data after JSON array", 422);
        continue;
      }
      if (!inString && depth === 0 && (char === "," || char === "]")) {
        const value = item.trim();
        item = "";
        itemBytes = 0;
        if (value) yield value;
        if (char === "]") finished = true;
        continue;
      }

      item += char;
      itemBytes += encoder.encode(char).byteLength;
      if (itemBytes > maxItemBytes) {
        throw new AppError("PERMANENT_PARSER", `JSON item exceeds ${maxItemBytes} bytes`, 422);
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") depth -= 1;
      if (depth < 0) throw new AppError("PERMANENT_PARSER", "Invalid JSON nesting", 422);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError("Expected a byte stream");
      for (const raw of feed(decoder.decode(value, { stream: true }))) yield JSON.parse(raw);
    }
    for (const raw of feed(decoder.decode())) yield JSON.parse(raw);
  } finally {
    reader.releaseLock();
  }
  if (!started || !finished || inString || depth !== 0 || item.trim()) {
    throw new AppError("PERMANENT_PARSER", "Truncated JSON array", 422);
  }
}
