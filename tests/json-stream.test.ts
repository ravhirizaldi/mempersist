import { describe, expect, it } from "vitest";
import { streamJsonArray } from "../src/json-stream";

function fragmentedStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += size)
        controller.enqueue(bytes.slice(index, index + size));
      controller.close();
    },
  });
}

describe("streaming JSON array parser", () => {
  it("handles strings, escapes, nested arrays, and chunk boundaries", async () => {
    const values: unknown[] = [];
    const encoded = JSON.stringify([{ a: 'x}"' }, [1, 2], null]);
    for await (const value of streamJsonArray(fragmentedStream(encoded, 3))) {
      values.push(value);
    }
    expect(values).toEqual([{ a: 'x}"' }, [1, 2], null]);
  });

  it("rejects a truncated export", async () => {
    const read = async () => {
      for await (const value of streamJsonArray(fragmentedStream('[{"a":1}', 2))) {
        void value;
      }
    };
    await expect(read()).rejects.toThrow("Truncated JSON array");
  });
});
