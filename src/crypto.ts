const encoder = new TextEncoder();

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key] ?? null)}`)
    .join(",")}}`;
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(value: ArrayBuffer | Uint8Array): Promise<string> {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes.buffer));
}

export async function sha256(value: string): Promise<string> {
  return sha256Bytes(encoder.encode(value));
}

export async function domainId(domain: string, ...parts: Array<string | null>): Promise<string> {
  return sha256([domain, ...parts.map((part) => part ?? "")].join("\u001f"));
}

export async function verifySecret(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

export async function digestStream(stream: ReadableStream<unknown>): Promise<string> {
  const digest = createHash("sha256");
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError("Expected a byte stream");
      digest.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return digest.digest("hex");
}
import { createHash, timingSafeEqual } from "node:crypto";
