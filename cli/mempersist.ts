import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const baseUrl = (process.env.MEMPERSIST_URL ?? "http://localhost:8787").replace(/\/$/u, "");
const token = process.env.MEMPERSIST_TOKEN;

function usage(): never {
  console.error(`Usage:
  yarn admin import <conversations.json>
  yarn admin status <import-id>
  yarn admin retry <job-id>
  yarn admin reindex
  yarn admin verify
  yarn admin search <query>`);
  process.exit(2);
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!token) throw new Error("MEMPERSIST_TOKEN is required");
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function importFile(path: string): Promise<unknown> {
  const info = await stat(path);
  const filename = basename(path);
  const partSize = 16 * 1024 * 1024;
  if (info.size <= partSize) {
    return api("/api/imports/direct", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(info.size),
        "x-filename": filename,
      },
      body: await readFile(path),
    });
  }
  const created = (await api("/api/imports/multipart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename }),
  })) as { importId: string };
  const file = await open(path, "r");
  try {
    let position = 0;
    let partNumber = 1;
    while (position < info.size) {
      const size = Math.min(partSize, info.size - position);
      const buffer = new Uint8Array(size);
      const { bytesRead } = await file.read(buffer, 0, size, position);
      await api(`/api/imports/${created.importId}/parts/${partNumber}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytesRead),
        },
        body: buffer.subarray(0, bytesRead),
      });
      position += bytesRead;
      partNumber += 1;
    }
  } finally {
    await file.close();
  }
  return api(`/api/imports/${created.importId}/complete`, { method: "POST" });
}

const [command, argument] = process.argv.slice(2);
if (!command) usage();

let result: unknown;
switch (command) {
  case "import":
    if (!argument) usage();
    result = await importFile(argument);
    break;
  case "status":
    if (!argument) usage();
    result = await api(`/api/imports/${argument}`);
    break;
  case "retry":
    if (!argument) usage();
    result = await api(`/api/admin/jobs/${argument}/retry`, { method: "POST" });
    break;
  case "reindex":
    result = await api("/api/admin/reindex", { method: "POST" });
    break;
  case "verify":
    result = await api("/api/admin/integrity");
    break;
  case "search":
    if (!argument) usage();
    result = await api(`/api/search?q=${encodeURIComponent(argument)}`);
    break;
  default:
    usage();
}
console.log(JSON.stringify(result, null, 2));
