import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpConversation, normalizeChatGptConversation } from "../src/chatgpt";
import {
  buildContext,
  ESTIMATOR_VERSION,
  type ContextPackComplete,
  type ContextPackRequiredBudgetExceeded,
} from "../src/context";
import { EMBEDDING_DIMENSIONS } from "../src/domain";
import { indexRevision, type IndexingEnv } from "../src/indexing";
import { buildContextOutputSchema, createMemoryMcpServer } from "../src/mcp";
import type { SearchEnv } from "../src/search";
import * as storage from "../src/storage";
import { appendConversation, writeCanonicalConversation } from "../src/storage";
import {
  getOrCreateUser,
  grantNamespace,
  OWNER_DB_USER_ID,
  resolveTenant,
  type Tenant,
} from "../src/tenant";
import { branchedChatGptConversation } from "./fixtures/chatgpt";

const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);

function indexingEnv(): IndexingEnv {
  return {
    MEMORY_DB: env.MEMORY_DB,
    MEMORY_BUCKET: env.MEMORY_BUCKET,
    AI: {
      run: () => Promise.resolve({ data: [embedding] }),
    },
    MEMORY_VECTOR: {
      deleteByIds: (ids) =>
        Promise.resolve({ mutationId: "test-delete-mutation", ids, count: ids.length }),
      upsert: () => Promise.resolve({ mutationId: "test-mutation", ids: [], count: 0 }),
    },
  };
}

type CallResult =
  { isError: true; text: string } | { isError: false; text: string; value: unknown };

const connections: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function connectedClient(tenant: Tenant) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "context-test-client", version: "1.0.0" });
  const server = createMemoryMcpServer(env, tenant);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

async function ownerClient(namespaces: string[] = ["personal", "work"]) {
  for (const ns of namespaces) {
    await grantNamespace(env, OWNER_DB_USER_ID, ns);
  }
  return await connectedClient(await resolveTenant(env, { userId: "owner" }));
}

async function callRaw(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(result.content);
  const text = content[0]!.text;
  if (result.isError === true) {
    return { isError: true, text };
  }
  return { isError: false, text, value: JSON.parse(text) as unknown };
}

async function callContext(client: Client, args: Record<string, unknown>) {
  const result = await callRaw(client, "memory_build_context", args);
  if (result.isError) {
    throw new Error(result.text);
  }
  return buildContextOutputSchema.parse(result.value);
}

async function storeConversation(options: {
  title: string;
  namespace?: string;
  tags?: string[];
  userId?: string;
  messages: Array<{ role: string; content: string; timestamp?: string }>;
}) {
  const userId = options.userId ?? OWNER_DB_USER_ID;
  const namespace = options.namespace ?? "personal";
  await grantNamespace(env, userId, namespace);
  const conversation = await createMcpConversation({
    title: options.title,
    namespace,
    tags: options.tags ?? ["runtime"],
    messages: options.messages,
  });
  const stored = await writeCanonicalConversation(env, conversation, null, null, userId);
  return { conversation, stored };
}

describe("memory_build_context integration", () => {
  it("resolves required conversations by exact title and conversation_id", async () => {
    const client = await ownerClient();
    const conv1 = await storeConversation({
      title: "CURRENT_SCENE",
      messages: [
        { role: "user", content: "Scene one opens at the desk." },
        { role: "assistant", content: "Agent acknowledges the assignment." },
      ],
    });
    const conv2 = await storeConversation({
      title: "EVENTS_INDEX",
      messages: [{ role: "system", content: "Timeline summary: gate opened." }],
    });

    const output = await callContext(client, {
      task: "Prepare context for next scene step",
      required: [
        {
          selector: { title: "CURRENT_SCENE" },
          mode: "full",
          branch: "active",
          priority: 100,
        },
        {
          selector: { conversation_id: conv2.conversation.id },
          mode: "full",
          branch: "active",
          priority: 90,
        },
      ],
      budget: {
        max_estimated_tokens: 4000,
        max_serialized_bytes: 32768,
      },
      options: {
        deduplicate: true,
        include_provenance: true,
        include_compiled_text: true,
      },
    });

    expect(output.status).toBe("complete");
    const complete = output as ContextPackComplete;
    expect(complete.task).toBe("Prepare context for next scene step");
    expect(complete.revision_pins).toHaveLength(2);
    expect(complete.revision_pins).toEqual(
      expect.arrayContaining([
        {
          conversation_id: conv1.conversation.id,
          revision_id: conv1.stored.revisionId,
          title: "CURRENT_SCENE",
          namespace: "personal",
        },
        {
          conversation_id: conv2.conversation.id,
          revision_id: conv2.stored.revisionId,
          title: "EVENTS_INDEX",
          namespace: "personal",
        },
      ]),
    );

    expect(complete.sections).toHaveLength(2);
    expect(complete.sections[0]!.kind).toBe("required");
    expect(complete.sections[0]!.title).toBe("CURRENT_SCENE");
    expect(complete.sections[0]!.priority).toBe(100);
    expect(complete.sections[0]!.messages).toHaveLength(2);
    expect(complete.sections[0]!.messages[0]!.text).toBe("Scene one opens at the desk.");
    expect(complete.sections[0]!.messages[0]!.provenance).toBeDefined();
    expect(complete.sections[0]!.messages[0]!.provenance?.kind).toBe("required");
    expect(complete.sections[0]!.messages[0]!.provenance?.conversation_id).toBe(
      conv1.conversation.id,
    );

    expect(complete.sections[1]!.kind).toBe("required");
    expect(complete.sections[1]!.title).toBe("EVENTS_INDEX");
    expect(complete.sections[1]!.priority).toBe(90);

    expect(complete.budget.used_estimated_tokens).toBeGreaterThan(0);
    expect(complete.budget.used_serialized_bytes).toBeGreaterThan(0);
    expect(complete.budget.estimator).toBe(ESTIMATOR_VERSION);
    expect(complete.compiled_text).toContain("[REQUIRED MEMORY: CURRENT_SCENE]");
    expect(complete.compiled_text).toContain("Scene one opens at the desk.");
    expect(complete.compiled_text).toContain("[REQUIRED MEMORY: EVENTS_INDEX]");
  });

  it("fails with NOT_FOUND for missing title or conversation_id", async () => {
    const client = await ownerClient();

    const missingTitleResult = await callRaw(client, "memory_build_context", {
      task: "Lookup missing title",
      required: [
        {
          selector: { title: "NON_EXISTENT_TITLE_999" },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(missingTitleResult.isError).toBe(true);
    expect(missingTitleResult.text).toContain(
      'Required conversation "NON_EXISTENT_TITLE_999" not found',
    );

    const missingIdResult = await callRaw(client, "memory_build_context", {
      task: "Lookup missing ID",
      required: [
        {
          selector: { conversation_id: "00000000-0000-0000-0000-000000000000" },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(missingIdResult.isError).toBe(true);
    expect(missingIdResult.text).toContain(
      'Required conversation "00000000-0000-0000-0000-000000000000" not found',
    );
  });

  it("fails with VALIDATION when title selector matches ambiguous conversations", async () => {
    const client = await ownerClient();
    const ambiguousTitle = `AMBIGUOUS_${crypto.randomUUID().slice(0, 8)}`;
    await storeConversation({
      title: ambiguousTitle,
      namespace: "personal",
      messages: [{ role: "user", content: "Copy 1" }],
    });
    await storeConversation({
      title: ambiguousTitle,
      namespace: "personal",
      messages: [{ role: "user", content: "Copy 2" }],
    });

    const result = await callRaw(client, "memory_build_context", {
      task: "Ambiguous title resolution test",
      required: [
        {
          selector: { title: ambiguousTitle },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      `Required conversation "${ambiguousTitle}" is ambiguous (2 matches)`,
    );
  });

  it("rejects selectors that specify both or neither conversation_id and title", async () => {
    const client = await ownerClient();

    const bothResult = await callRaw(client, "memory_build_context", {
      task: "Invalid selector: both id and title",
      required: [
        {
          selector: {
            conversation_id: "00000000-0000-0000-0000-000000000000",
            title: "DUAL_SPEC",
          },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(bothResult.isError).toBe(true);

    const neitherResult = await callRaw(client, "memory_build_context", {
      task: "Invalid selector: empty selector",
      required: [
        {
          selector: {},
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(neitherResult.isError).toBe(true);
  });

  it("respects mode: 'tail' and mode: 'full'", async () => {
    const client = await ownerClient();
    const conv = await storeConversation({
      title: "TAIL_TEST",
      messages: [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Message 2" },
        { role: "user", content: "Message 3" },
        { role: "assistant", content: "Message 4" },
        { role: "user", content: "Message 5" },
      ],
    });

    const tailOutput = await callContext(client, {
      task: "Tail mode extraction",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "tail",
          tail_messages: 2,
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });

    expect(tailOutput.status).toBe("complete");
    const tailComplete = tailOutput as ContextPackComplete;
    expect(tailComplete.sections[0]!.messages).toHaveLength(2);
    expect(tailComplete.sections[0]!.messages[0]!.text).toBe("Message 4");
    expect(tailComplete.sections[0]!.messages[1]!.text).toBe("Message 5");

    const fullOutput = await callContext(client, {
      task: "Full mode extraction",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });

    expect(fullOutput.status).toBe("complete");
    const fullComplete = fullOutput as ContextPackComplete;
    expect(fullComplete.sections[0]!.messages).toHaveLength(5);
    expect(fullComplete.sections[0]!.messages[0]!.text).toBe("Message 1");
    expect(fullComplete.sections[0]!.messages[4]!.text).toBe("Message 5");
  });

  it("respects branch: 'active' versus branch: 'all' on branched conversations", async () => {
    const client = await ownerClient();
    const rawBranched = await normalizeChatGptConversation(branchedChatGptConversation());
    rawBranched.id = crypto.randomUUID();
    rawBranched.namespace = "personal";
    await writeCanonicalConversation(env, rawBranched, null, null, OWNER_DB_USER_ID);

    const activeOutput = await callContext(client, {
      task: "Active branch extraction",
      required: [
        {
          selector: { conversation_id: rawBranched.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });
    expect(activeOutput.status).toBe("complete");
    const activeComplete = activeOutput as ContextPackComplete;
    expect(activeComplete.sections[0]!.messages).toHaveLength(2);
    const activeTexts = activeComplete.sections[0]!.messages.map((m) => m.text);
    expect(activeTexts).toContain("Bagaimana migrasi database atlas-db?");
    expect(activeTexts).toContain(
      "Use additive migration 0007 and keep api.internal.example unchanged.",
    );
    expect(activeTexts).not.toContain("Alternate branch: rebuild atlas-db from scratch.");

    const allOutput = await callContext(client, {
      task: "All branches extraction",
      required: [
        {
          selector: { conversation_id: rawBranched.id },
          mode: "full",
          branch: "all",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });
    expect(allOutput.status).toBe("complete");
    const allComplete = allOutput as ContextPackComplete;
    expect(allComplete.sections[0]!.messages).toHaveLength(3);
    const allTexts = allComplete.sections[0]!.messages.map((m) => m.text);
    expect(allTexts).toContain("Alternate branch: rebuild atlas-db from scratch.");
  });

  it("pins revision ID and prevents mixing revisions across concurrent appends", async () => {
    const client = await ownerClient();
    const conv = await storeConversation({
      title: "PINNING_BASE",
      messages: [{ role: "user", content: "Original revision message." }],
    });
    const rev1 = conv.stored.revisionId;

    const initialPack = await callContext(client, {
      task: "Check initial revision pin",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });
    expect(initialPack.status).toBe("complete");
    const initialComplete = initialPack as ContextPackComplete;
    expect(initialComplete.revision_pins[0]!.revision_id).toBe(rev1);
    expect(initialComplete.sections[0]!.revision_id).toBe(rev1);
    expect(initialComplete.sections[0]!.messages).toHaveLength(1);

    // Append new message creating revision R2
    const appended = await appendConversation(
      env,
      conv.conversation.id,
      rev1,
      [{ role: "assistant", content: "Appended second message." }],
      undefined,
      ["personal"],
      OWNER_DB_USER_ID,
    );
    const rev2 = appended.revisionId;
    expect(rev2).not.toBe(rev1);

    // Context built after append pins rev2, with neither pack mixing nodes
    const postAppendPack = await callContext(client, {
      task: "Check post-append revision pin",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });
    expect(postAppendPack.status).toBe("complete");
    const postComplete = postAppendPack as ContextPackComplete;
    expect(postComplete.revision_pins[0]!.revision_id).toBe(rev2);
    expect(postComplete.sections[0]!.revision_id).toBe(rev2);
    expect(postComplete.sections[0]!.messages).toHaveLength(2);
    expect(postComplete.sections[0]!.messages[0]!.revision_id).toBe(rev2);
    expect(postComplete.sections[0]!.messages[1]!.revision_id).toBe(rev2);
  });

  it("deduplicates overlapping retrieved content and attaches provenance to required messages", async () => {
    const client = await ownerClient();
    const secretCode = `codex-delta-${crypto.randomUUID().slice(0, 8)}`;

    const mainConv = await storeConversation({
      title: "PRIMARY_DOCUMENT",
      messages: [
        { role: "user", content: `Instruction with unique keyword ${secretCode} for retrieval.` },
        { role: "assistant", content: "Instruction received and noted." },
      ],
    });
    await indexRevision(indexingEnv(), mainConv.stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    const secondaryConv = await storeConversation({
      title: "SECONDARY_DOCUMENT",
      messages: [{ role: "user", content: `Contextual notes on ${secretCode} operation.` }],
    });
    await indexRevision(
      indexingEnv(),
      secondaryConv.stored.revisionId,
      env.ACTIVE_INDEX_GENERATION,
    );

    const pack = await callContext(client, {
      task: "Overlap and provenance test",
      required: [
        {
          selector: { title: "PRIMARY_DOCUMENT" },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: [
        {
          query: secretCode,
          limit: 5,
          priority: 80,
          context_before: 1,
          context_after: 1,
        },
      ],
      budget: { max_estimated_tokens: 4000, max_serialized_bytes: 32768 },
      options: {
        deduplicate: true,
        include_provenance: true,
        include_compiled_text: true,
      },
    });

    expect(pack.status).toBe("complete");
    const complete = pack as ContextPackComplete;
    expect(complete.sections.length).toBeGreaterThanOrEqual(1);

    const requiredSection = complete.sections.find((s) => s.title === "PRIMARY_DOCUMENT");
    expect(requiredSection).toBeDefined();
    expect(requiredSection?.kind).toBe("required");

    // The primary conversation's message should have provenance attached with chunk_ids
    const matchedMessage = requiredSection?.messages.find((m) => m.text.includes(secretCode));
    expect(matchedMessage).toBeDefined();
    expect(matchedMessage?.provenance?.kind).toBe("required");
    expect(matchedMessage?.provenance?.chunk_ids).toBeDefined();
    expect(matchedMessage?.provenance?.chunk_ids!.length).toBeGreaterThan(0);

    // Deduplication check: PRIMARY_DOCUMENT messages are not duplicated in a separate retrieved section
    const retrievedPrimarySections = complete.sections.filter(
      (s) => s.kind === "retrieved" && s.conversation_id === mainConv.conversation.id,
    );
    expect(retrievedPrimarySections).toHaveLength(0);

    // If secondary document matched, it is admitted as a retrieved section
    const retrievedSecondary = complete.sections.find(
      (s) => s.kind === "retrieved" && s.conversation_id === secondaryConv.conversation.id,
    );
    if (retrievedSecondary) {
      expect(retrievedSecondary.kind).toBe("retrieved");
      expect(retrievedSecondary.messages[0]!.provenance?.kind).toBe("retrieved");
    }
  });

  it("handles degraded search gracefully via buildContext direct invocation", async () => {
    const tenant = await resolveTenant(env, { userId: "owner" });
    await grantNamespace(env, OWNER_DB_USER_ID, "personal");

    const conv = await storeConversation({
      title: "DEGRADED_SOURCE",
      messages: [{ role: "user", content: "Safe canonical data." }],
    });

    const degradedSearchEnv = {
      ...env,
      AI: {
        run: () => Promise.reject(new Error("AI embedding service is degraded")),
      } as SearchEnv["AI"],
      MEMORY_VECTOR: {
        query: () => Promise.reject(new Error("Vectorize service outage")),
      } as SearchEnv["MEMORY_VECTOR"],
    } as SearchEnv & typeof env;

    const pack = await buildContext(degradedSearchEnv, tenant, {
      task: "Degraded search resilience",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: [
        {
          query: "semantic search query that fails",
          limit: 4,
          priority: 50,
          context_before: 1,
          context_after: 1,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });

    expect(pack.status).toBe("complete");
    if (pack.status === "complete") {
      expect(pack.sections).toHaveLength(1);
      expect(pack.sections[0]!.title).toBe("DEGRADED_SOURCE");
      expect(pack.sections[0]!.messages[0]!.text).toBe("Safe canonical data.");
      expect(pack.degraded).toBe(true);
    }
  });

  it("produces deterministic ordering and stable pack_id across builds", async () => {
    const client = await ownerClient();
    const convA = await storeConversation({
      title: "ORDER_LOW_PRIORITY",
      messages: [{ role: "user", content: "Low priority message." }],
    });
    const convB = await storeConversation({
      title: "ORDER_HIGH_PRIORITY",
      messages: [{ role: "user", content: "High priority message." }],
    });

    const requestArgs = {
      task: "Check deterministic sorting and pack_id",
      required: [
        {
          selector: { conversation_id: convA.conversation.id },
          mode: "full",
          branch: "active",
          priority: 20,
        },
        {
          selector: { conversation_id: convB.conversation.id },
          mode: "full",
          branch: "active",
          priority: 95,
        },
      ],
      budget: { max_estimated_tokens: 3000, max_serialized_bytes: 25000 },
      options: {
        deduplicate: true,
        include_provenance: true,
        include_compiled_text: true,
      },
    };

    const pack1 = (await callContext(client, requestArgs)) as ContextPackComplete;
    const pack2 = (await callContext(client, requestArgs)) as ContextPackComplete;

    expect(pack1.pack_id).toBe(pack2.pack_id);
    expect(pack1.sections).toEqual(pack2.sections);
    expect(pack1.compiled_text).toBe(pack2.compiled_text);

    // Authority / priority ordering: higher priority section is listed first
    expect(pack1.sections[0]!.title).toBe("ORDER_HIGH_PRIORITY");
    expect(pack1.sections[0]!.priority).toBe(95);
    expect(pack1.sections[1]!.title).toBe("ORDER_LOW_PRIORITY");
    expect(pack1.sections[1]!.priority).toBe(20);
  });

  it("omits retrieved candidates when exceeding token or byte budgets without truncating whole messages", async () => {
    const client = await ownerClient();
    const uniqueQuery = `budget-check-${crypto.randomUUID().slice(0, 8)}`;

    const requiredConv = await storeConversation({
      title: "REQUIRED_BUDGET_BASE",
      messages: [{ role: "user", content: "Essential prompt context." }],
    });

    const retrievedConv = await storeConversation({
      title: "RETRIEVED_BUDGET_OVERFLOW",
      messages: [
        {
          role: "user",
          content: `${uniqueQuery}: Long message with voluminous background evidence that requires substantial token allocation to include in full.`,
        },
      ],
    });
    await indexRevision(
      indexingEnv(),
      retrievedConv.stored.revisionId,
      env.ACTIVE_INDEX_GENERATION,
    );

    // Set token budget tight enough for required content, but insufficient for retrieved content
    const pack = (await callContext(client, {
      task: "Whole message budget boundary",
      required: [
        {
          selector: { conversation_id: requiredConv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: [
        {
          query: uniqueQuery,
          limit: 5,
          priority: 50,
        },
      ],
      // 10 estimated tokens allows the required short message, but excludes the retrieved candidate
      budget: { max_estimated_tokens: 10, max_serialized_bytes: 40000 },
    })) as ContextPackComplete;

    expect(pack.status).toBe("complete");
    expect(pack.sections).toHaveLength(1);
    expect(pack.sections[0]!.conversation_id).toBe(requiredConv.conversation.id);
    expect(pack.sections[0]!.messages[0]!.text).toBe("Essential prompt context.");

    // The whole retrieved candidate was omitted due to budget, not truncated
    expect(pack.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "retrieved",
          conversation_id: retrievedConv.conversation.id,
          reason: "budget",
        }),
      ]),
    );
  });

  it("returns status: 'required_budget_exceeded' with suggested minimums when required content exceeds budget", async () => {
    const client = await ownerClient();
    const conv = await storeConversation({
      title: "OVERFLOW_REQUIRED",
      messages: [
        {
          role: "user",
          content:
            "A message with enough words to comfortably exceed an artificially low 2-token budget limit.",
        },
      ],
    });

    const result = await callContext(client, {
      task: "Required budget overflow test",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: {
        max_estimated_tokens: 2,
        max_serialized_bytes: 20000,
      },
    });

    expect(result.status).toBe("required_budget_exceeded");
    const exceeded = result as ContextPackRequiredBudgetExceeded;
    expect(exceeded.required_estimated_tokens).toBeGreaterThan(2);
    expect(exceeded.suggested_minimum.max_estimated_tokens).toBeGreaterThanOrEqual(
      exceeded.required_estimated_tokens,
    );
    expect(exceeded.suggested_minimum.max_serialized_bytes).toBeGreaterThanOrEqual(
      exceeded.required_serialized_bytes,
    );
  });

  it("emits OVERSIZED_MESSAGE warning when a single message exceeds byte budget", async () => {
    const client = await ownerClient();
    const largeText = "X".repeat(600);
    const conv = await storeConversation({
      title: "OVERSIZED_TEST",
      messages: [{ role: "user", content: largeText }],
    });

    const result = await callContext(client, {
      task: "Oversized message diagnostic test",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: {
        max_estimated_tokens: 5000,
        // Set max_serialized_bytes lower than the message JSON size
        max_serialized_bytes: 300,
      },
    });

    expect(result.status).toBe("required_budget_exceeded");
    const exceeded = result as ContextPackRequiredBudgetExceeded;
    const oversized = exceeded.warnings.find((w) => w.code === "OVERSIZED_MESSAGE");
    expect(oversized).toBeDefined();
    expect(oversized?.source_node_id).toBeDefined();
    expect(oversized?.bytes).toBeGreaterThan(300);
    // Ensure the message content was not leaked into the diagnostic message
    expect(oversized?.message).not.toContain(largeText);
  });

  it("handles Unicode text, emoji, and escape sequences verbatim with accurate byte measurement", async () => {
    const client = await ownerClient();
    const unicodeContent = 'Prompt rule: 雨 🌙 "Quoted" \\ \r\nSpecial: \u0000 \t \u{1F680}';
    const conv = await storeConversation({
      title: "UNICODE_PRESERVATION",
      messages: [{ role: "user", content: unicodeContent }],
    });

    const output = (await callContext(client, {
      task: "Unicode handling verification",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
      options: { include_compiled_text: true },
    })) as ContextPackComplete;

    expect(output.status).toBe("complete");
    expect(output.sections[0]!.messages[0]!.text).toBe(unicodeContent);
    expect(output.compiled_text).toContain(unicodeContent);
    expect(output.budget.used_serialized_bytes).toBeGreaterThan(
      new TextEncoder().encode(unicodeContent).byteLength,
    );
  });

  it("enforces cross-tenant isolation and prevents access to other tenants' conversations", async () => {
    // Tenant 1 owns personal namespace and creates a private conversation
    await grantNamespace(env, OWNER_DB_USER_ID, "personal");
    const tenant1Conv = await storeConversation({
      title: "TENANT_1_SECRET",
      userId: OWNER_DB_USER_ID,
      messages: [{ role: "user", content: "Confidential data for owner." }],
    });

    // Tenant 2 has a separate account
    const tenant2User = await getOrCreateUser(env, "tenant_2_external_user");
    await grantNamespace(env, tenant2User.id, "personal");
    const tenant2 = await resolveTenant(env, { userId: tenant2User.id });
    const tenant2Client = await connectedClient(tenant2);

    // Tenant 2 attempts lookup by title
    const titleResult = await callRaw(tenant2Client, "memory_build_context", {
      task: "Cross tenant title attack",
      required: [
        {
          selector: { title: "TENANT_1_SECRET" },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(titleResult.isError).toBe(true);
    expect(titleResult.text).toContain('Required conversation "TENANT_1_SECRET" not found');

    // Tenant 2 attempts lookup by exact conversation_id
    const idResult = await callRaw(tenant2Client, "memory_build_context", {
      task: "Cross tenant ID attack",
      required: [
        {
          selector: { conversation_id: tenant1Conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(idResult.isError).toBe(true);
    expect(idResult.text).toContain(
      `Required conversation "${tenant1Conv.conversation.id}" not found`,
    );
  });

  it("enforces namespace scoping and rejects unauthorized namespaces", async () => {
    const client = await ownerClient(["personal", "work"]);
    await storeConversation({
      title: "WORK_ONLY_CONV",
      namespace: "work",
      messages: [{ role: "user", content: "Work content only." }],
    });

    // Scoping request to "personal" should not find conversation in "work"
    const scopedResult = await callRaw(client, "memory_build_context", {
      namespace: "personal",
      task: "Scoped lookup test",
      required: [
        {
          selector: { title: "WORK_ONLY_CONV" },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(scopedResult.isError).toBe(true);
    expect(scopedResult.text).toContain('Required conversation "WORK_ONLY_CONV" not found');

    // Requesting an unowned namespace fails with 403
    const forbiddenResult = await callRaw(client, "memory_build_context", {
      namespace: "unowned_restricted_ns",
      task: "Unauthorized namespace access test",
      required: [
        {
          selector: { title: "ANY_TITLE" },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 1000, max_serialized_bytes: 10000 },
    });
    expect(forbiddenResult.isError).toBe(true);
    expect(forbiddenResult.text).toContain("Namespace is not accessible to this account");
  });
  it("canonicalizes duplicate required title and ID selectors to one revision pin and never mixes sections across an append", async () => {
    const client = await ownerClient();
    const uniqueTitle = `DUP_SELECTOR_TEST_${crypto.randomUUID().slice(0, 8)}`;
    const conv = await storeConversation({
      title: uniqueTitle,
      messages: [{ role: "user", content: "Revision 1 base content." }],
    });
    const rev1 = conv.stored.revisionId;

    // Simulate an append occurring after title resolution but before ID resolution
    let rev2: string | undefined;
    const originalResolve = storage.resolveConversations;
    vi.spyOn(storage, "resolveConversations").mockImplementation(async (...args) => {
      const result = await originalResolve(...args);
      // Append a second message to the conversation, creating revision 2 in the database
      const appended = await appendConversation(
        env,
        conv.conversation.id,
        rev1,
        [{ role: "assistant", content: "Revision 2 appended message." }],
        undefined,
        ["personal"],
        OWNER_DB_USER_ID,
      );
      rev2 = appended.revisionId;
      return result;
    });

    const output = (await callContext(client, {
      task: "Verify duplicate selector canonicalization across append",
      required: [
        {
          selector: { title: uniqueTitle },
          mode: "full",
          branch: "active",
          priority: 100,
        },
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 90,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
      options: { deduplicate: false },
    })) as ContextPackComplete;

    expect(output.status).toBe("complete");
    expect(rev2).toBeDefined();
    expect(rev2).not.toBe(rev1);

    // Exactly one revision pin reported for this conversation ID
    const pins = output.revision_pins.filter((p) => p.conversation_id === conv.conversation.id);
    expect(pins).toHaveLength(1);
    const pinnedRevisionId = pins[0]!.revision_id;
    expect([rev1, rev2]).toContain(pinnedRevisionId);

    // All sections for this conversation in the pack must use the single pinned revision
    const convSections = output.sections.filter((s) => s.conversation_id === conv.conversation.id);
    expect(convSections.length).toBeGreaterThanOrEqual(1);
    for (const section of convSections) {
      expect(section.revision_id).toBe(pinnedRevisionId);
      for (const msg of section.messages) {
        expect(msg.revision_id).toBe(pinnedRevisionId);
      }
    }

    // Never mix sections from the other unpinned revision
    const unpinnedRevisionId = pinnedRevisionId === rev1 ? rev2 : rev1;
    expect(convSections.some((s) => s.revision_id === unpinnedRevisionId)).toBe(false);
  });

  it("deduplicates source nodes across overlapping retrieved hits and merges evidence on the first placement", async () => {
    const client = await ownerClient();
    const tag = `overlap-${crypto.randomUUID().slice(0, 8)}`;
    const anchorA = `ANCHOR_A_${tag}`;
    const anchorB = `ANCHOR_B_${tag}`;
    const sharedText = `SHARED_KNOWLEDGE_${tag} critical shared statement`;
    const anchorPadding = " supporting context".repeat(20);

    // Unrelated required document so both search hits are optional (retrieved)
    const requiredConv = await storeConversation({
      title: `REQUIRED_DOC_${tag}`,
      messages: [{ role: "user", content: "Foundational required context." }],
    });

    // Retrieved conversation with 3 messages:
    // [0]: matches anchorA (Hit 1)
    // [1]: shared message between Hit 1 and Hit 2
    // [2]: matches anchorB (Hit 2)
    const retrievedConv = await storeConversation({
      title: `RETRIEVED_SOURCE_${tag}`,
      messages: [
        { role: "user", content: `Lead-in premise referencing ${anchorA}${anchorPadding}` },
        { role: "assistant", content: sharedText },
        { role: "user", content: `Follow-up query referencing ${anchorB}${anchorPadding}` },
      ],
    });
    await indexRevision(
      indexingEnv(),
      retrievedConv.stored.revisionId,
      env.ACTIVE_INDEX_GENERATION,
    );

    const sharedNodeId = retrievedConv.conversation.nodes[1]!.sourceNodeId;

    const pack = (await callContext(client, {
      task: "Test retrieval overlap across two hits",
      required: [
        {
          selector: { conversation_id: requiredConv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: [
        {
          query: anchorA,
          limit: 5,
          priority: 90,
          context_before: 0,
          context_after: 1, // captures [0] and [1]
        },
        {
          query: anchorB,
          limit: 5,
          priority: 80,
          context_before: 1, // captures [1] and [2]
          context_after: 0,
        },
      ],
      budget: { max_estimated_tokens: 3000, max_serialized_bytes: 25000 },
      options: {
        deduplicate: true,
        include_provenance: true,
      },
    })) as ContextPackComplete;

    expect(pack.status).toBe("complete");

    // The shared source node must appear exactly once in the entire pack (never duplicated)
    const allMessageNodes = pack.sections.flatMap((s) => s.messages.map((m) => m.source_node_id));
    expect(allMessageNodes.filter((id) => id === sharedNodeId)).toHaveLength(1);

    // Hit 1 (priority 90) was placed first; its section must contain the shared message
    const firstSection = pack.sections.find((s) => s.priority === 90);
    expect(firstSection).toBeDefined();
    const placedSharedMsg = firstSection?.messages.find((m) => m.source_node_id === sharedNodeId);
    expect(placedSharedMsg).toBeDefined();

    // Evidence from Hit 2 must be merged into the first placement's provenance and matched_chunk_ids
    expect(placedSharedMsg?.provenance?.chunk_ids?.length).toBeGreaterThan(1);
    expect(firstSection?.matched_chunk_ids?.length).toBeGreaterThan(1);

    // Hit 2's section (if admitted) must NOT include the shared message
    const secondSection = pack.sections.find((s) => s.priority === 80);
    if (secondSection) {
      expect(secondSection.messages.some((m) => m.source_node_id === sharedNodeId)).toBe(false);
      // Hit 2's section matched_ranges must not contain ranges for the shared message
      if (secondSection.matched_ranges) {
        expect(secondSection.matched_ranges.some((r) => r.source_node_id === sharedNodeId)).toBe(
          false,
        );
      }
    }
  });

  it("bounds diagnostics and enforces used_serialized_bytes <= max when tight byte budget encounters multiple rejected and stale candidates", async () => {
    const client = await ownerClient();
    const tag = `budget-diag-${crypto.randomUUID().slice(0, 8)}`;

    const requiredConv = await storeConversation({
      title: `REQUIRED_TIGHT_${tag}`,
      messages: [{ role: "user", content: "Concise prompt." }],
    });

    // Stale candidate: indexed at revision 1, then appended to revision 2
    const staleQuery = `STALE_KEY_${tag}`;
    const staleConv = await storeConversation({
      title: `STALE_SOURCE_${tag}`,
      messages: [{ role: "user", content: `${staleQuery}: Initial version before update.` }],
    });
    await indexRevision(indexingEnv(), staleConv.stored.revisionId, env.ACTIVE_INDEX_GENERATION);
    await appendConversation(
      env,
      staleConv.conversation.id,
      staleConv.stored.revisionId,
      [{ role: "assistant", content: "Second version head advance." }],
      undefined,
      ["personal"],
      OWNER_DB_USER_ID,
    );

    // Overflow candidate with substantial text
    const overflowQuery = `OVERFLOW_KEY_${tag}`;
    const overflowConv = await storeConversation({
      title: `OVERFLOW_SOURCE_${tag}`,
      messages: [
        {
          role: "user",
          content: `${overflowQuery}: ${"Extensive background details. ".repeat(100)}`,
        },
      ],
    });
    await indexRevision(indexingEnv(), overflowConv.stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    // Set budget tight enough for required content, but excluding retrieval candidates and forcing diagnostic bounds
    const maxBytes = 3000;
    const pack = (await callContext(client, {
      task: "Tight byte budget with rejected/stale candidates",
      required: [
        {
          selector: { conversation_id: requiredConv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: [
        { query: staleQuery, limit: 3, priority: 80 },
        { query: overflowQuery, limit: 3, priority: 70 },
      ],
      budget: { max_estimated_tokens: 3000, max_serialized_bytes: maxBytes },
      options: { deduplicate: true, include_provenance: true },
    })) as ContextPackComplete;

    expect(pack.status).toBe("complete");
    expect(pack.budget.used_serialized_bytes).toBeLessThanOrEqual(maxBytes);
    expect(pack.budget.used_serialized_bytes).toBeLessThanOrEqual(49152);

    // Accurate serialization measurement matches or stays under budget
    const serializedPackLength = new TextEncoder().encode(JSON.stringify(pack)).byteLength;
    expect(serializedPackLength).toBeLessThanOrEqual(maxBytes);

    // Required section admitted
    expect(pack.sections).toHaveLength(1);
    expect(pack.sections[0]!.conversation_id).toBe(requiredConv.conversation.id);

    // Omitted list contains rejected candidates with bounded diagnostics
    expect(pack.omitted.length).toBeGreaterThanOrEqual(1);
    expect(pack.omitted.some((o) => o.reason === "stale_revision" || o.reason === "budget")).toBe(
      true,
    );
  });

  it("emits OVERSIZED_MESSAGE warning with source identity and byte count without leaking message text for optional oversized messages", async () => {
    const client = await ownerClient();
    const tag = `opt-oversized-${crypto.randomUUID().slice(0, 8)}`;
    const queryTerm = `OVERSIZED_OPT_QUERY_${tag}`;

    const requiredConv = await storeConversation({
      title: `REQUIRED_NORMAL_${tag}`,
      messages: [{ role: "user", content: "Standard base instruction." }],
    });
    const secretLargeContent = "CONFIDENTIAL_PAYLOAD_".repeat(240);
    const oversizedConv = await storeConversation({
      title: `RETRIEVED_OVERSIZED_${tag}`,
      messages: [{ role: "user", content: `${queryTerm}: ${secretLargeContent}` }],
    });
    await indexRevision(
      indexingEnv(),
      oversizedConv.stored.revisionId,
      env.ACTIVE_INDEX_GENERATION,
    );

    const oversizedNodeId = oversizedConv.conversation.nodes[0]!.sourceNodeId;

    const byteLimit = 4000;
    const pack = (await callContext(client, {
      task: "Optional oversized message diagnostic test",
      required: [
        {
          selector: { conversation_id: requiredConv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: [
        {
          query: queryTerm,
          limit: 3,
          priority: 60,
        },
      ],
      budget: { max_estimated_tokens: 4000, max_serialized_bytes: byteLimit },
    })) as ContextPackComplete;

    // Optional content overflow must NOT cause status: "required_budget_exceeded"
    expect(pack.status).toBe("complete");

    // The oversized candidate is omitted due to budget
    expect(pack.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "retrieved",
          conversation_id: oversizedConv.conversation.id,
          reason: "budget",
        }),
      ]),
    );

    // OVERSIZED_MESSAGE warning emitted with identity and bytes, but without text leakage
    const oversizedWarning = pack.warnings?.find(
      (w) => w.code === "OVERSIZED_MESSAGE" && w.source_node_id === oversizedNodeId,
    );
    expect(oversizedWarning).toBeDefined();
    expect(oversizedWarning?.conversation_id).toBe(oversizedConv.conversation.id);
    expect(oversizedWarning?.revision_id).toBe(oversizedConv.stored.revisionId);
    expect(oversizedWarning?.bytes).toBeGreaterThan(byteLimit);
    expect(oversizedWarning?.message).not.toContain(secretLargeContent);

    // Section not admitted
    expect(
      pack.sections.find((s) => s.conversation_id === oversizedConv.conversation.id),
    ).toBeUndefined();
  });
  it("caps optional warning diagnostics during collection", async () => {
    const client = await ownerClient();
    const tag = `warning-cap-${crypto.randomUUID().slice(0, 8)}`;
    const query = `WARNING_CAP_QUERY_${tag}`;
    const requiredConv = await storeConversation({
      title: `WARNING_CAP_REQUIRED_${tag}`,
      messages: [{ role: "user", content: "Required context." }],
    });
    const repeatedChunkText = `${query} ${"supporting context ".repeat(500)}`;
    const sourceConv = await storeConversation({
      title: `WARNING_CAP_SOURCE_${tag}`,
      messages: [
        {
          role: "user",
          content: Array.from({ length: 6 }, () => repeatedChunkText).join("\n\n"),
        },
      ],
    });
    await indexRevision(indexingEnv(), sourceConv.stored.revisionId, env.ACTIVE_INDEX_GENERATION);

    const retrieveRequests = Array.from({ length: 5 }, () => ({
      query,
      limit: 20,
      priority: 80,
      context_before: 0,
      context_after: 0,
    }));
    const expectedGeneratedWarnings = retrieveRequests.length * 5;
    const pack = (await callContext(client, {
      task: "Cap warning diagnostics",
      required: [
        {
          selector: { conversation_id: requiredConv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: retrieveRequests,
      budget: { max_estimated_tokens: 5000, max_serialized_bytes: 49152 },
      options: { include_compiled_text: false },
    })) as ContextPackComplete;

    expect(pack.status).toBe("complete");
    expect(pack.omitted).toHaveLength(expectedGeneratedWarnings);
    expect(pack.warnings).toHaveLength(20);
    expect(pack.warnings.at(-1)?.code).toBe("DIAGNOSTICS_TRUNCATED");
    const oversizedWarningCount = pack.warnings.filter(
      (warning) => warning.code === "OVERSIZED_MESSAGE",
    ).length;
    const truncationMessage = pack.warnings.at(-1)?.message ?? "";
    const truncationMatch = /^(\d+) additional context warnings truncated$/u.exec(
      truncationMessage,
    );
    expect(truncationMatch).not.toBeNull();
    expect(oversizedWarningCount).toBe(19);
    expect(Number(truncationMatch?.[1] ?? 0)).toBe(
      expectedGeneratedWarnings - oversizedWarningCount,
    );
    const tightPack = (await callContext(client, {
      task: "Cap warning diagnostics under tight bytes",
      required: [
        {
          selector: { conversation_id: requiredConv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: retrieveRequests,
      budget: { max_estimated_tokens: 5000, max_serialized_bytes: 3000 },
      options: { include_compiled_text: false },
    })) as ContextPackComplete;

    expect(tightPack.status).toBe("complete");
    expect(tightPack.budget.used_serialized_bytes).toBeLessThanOrEqual(3000);
    expect(tightPack.warnings).toHaveLength(1);
    expect(tightPack.warnings[0]?.code).toBe("DIAGNOSTICS_TRUNCATED");
    const tightTruncationMessage = tightPack.warnings[0]?.message ?? "";
    const tightTruncationMatch = /^(\d+) additional context warnings truncated$/u.exec(
      tightTruncationMessage,
    );
    expect(tightTruncationMatch).not.toBeNull();
    expect(Number(tightTruncationMatch?.[1] ?? 0)).toBe(expectedGeneratedWarnings);
    const serializedCandidateBytes = (
      includeSummary: boolean,
      includeUnavailable: boolean,
      maxSerializedBytes: number,
    ): number => {
      const candidate = structuredClone(tightPack);
      candidate.omitted = [];
      candidate.warnings = includeSummary ? [...tightPack.warnings] : [];
      candidate.unavailable = includeUnavailable ? [...tightPack.unavailable] : [];
      candidate.budget.max_serialized_bytes = maxSerializedBytes;
      candidate.budget.used_serialized_bytes = 0;
      const measuredBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
      candidate.budget.used_serialized_bytes = measuredBytes;
      return new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
    };
    let boundaryBudget = serializedCandidateBytes(false, true, 3000) + 1;
    boundaryBudget = serializedCandidateBytes(false, true, boundaryBudget) + 1;
    const withoutSummaryBytes = serializedCandidateBytes(false, true, boundaryBudget);
    const withSummaryBytes = serializedCandidateBytes(true, true, boundaryBudget);
    expect(withoutSummaryBytes).toBeLessThanOrEqual(boundaryBudget);
    expect(withSummaryBytes).toBeGreaterThan(boundaryBudget);
    const boundaryPack = (await callContext(client, {
      task: "Cap warning diagnostics under tight bytes",
      required: [
        {
          selector: { conversation_id: requiredConv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: retrieveRequests,
      budget: { max_estimated_tokens: 5000, max_serialized_bytes: boundaryBudget },
      options: { include_compiled_text: false },
    })) as ContextPackComplete;

    expect(boundaryPack.status).toBe("complete");
    expect(boundaryPack.degraded).toBe(true);
    expect(boundaryPack.warnings).toHaveLength(0);
    expect(boundaryPack.omitted).toHaveLength(0);
    const actualBoundaryBytes = new TextEncoder().encode(JSON.stringify(boundaryPack)).byteLength;
    expect(tightPack.degraded).toBe(true);
    expect(tightPack.unavailable.length).toBeGreaterThan(0);
    let degradedBoundaryBudget = serializedCandidateBytes(false, false, 3000) + 1;
    degradedBoundaryBudget = serializedCandidateBytes(false, false, degradedBoundaryBudget) + 1;
    const withoutUnavailableBytes = serializedCandidateBytes(false, false, degradedBoundaryBudget);
    const withUnavailableBytes = serializedCandidateBytes(false, true, degradedBoundaryBudget);
    expect(withoutUnavailableBytes).toBeLessThanOrEqual(degradedBoundaryBudget);
    expect(withUnavailableBytes).toBeGreaterThan(degradedBoundaryBudget);
    const degradedBoundaryPack = (await callContext(client, {
      task: "Cap warning diagnostics under tight bytes",
      required: [
        {
          selector: { conversation_id: requiredConv.conversation.id },
          mode: "full",
          branch: "active",
          priority: 100,
        },
      ],
      retrieve: retrieveRequests,
      budget: {
        max_estimated_tokens: 5000,
        max_serialized_bytes: degradedBoundaryBudget,
      },
      options: { include_compiled_text: false },
    })) as ContextPackComplete;

    expect(degradedBoundaryPack.status).toBe("complete");
    expect(degradedBoundaryPack.degraded).toBe(true);
    expect(degradedBoundaryPack.unavailable).toEqual([]);
    expect(degradedBoundaryPack.warnings).toHaveLength(0);
    expect(degradedBoundaryPack.omitted).toHaveLength(0);
    const actualDegradedBoundaryBytes = new TextEncoder().encode(
      JSON.stringify(degradedBoundaryPack),
    ).byteLength;
    expect(actualDegradedBoundaryBytes).toBeLessThanOrEqual(degradedBoundaryBudget);
    expect(degradedBoundaryPack.budget.used_serialized_bytes).toBe(actualDegradedBoundaryBytes);
    expect(actualBoundaryBytes).toBeLessThanOrEqual(boundaryBudget);
    expect(boundaryPack.budget.used_serialized_bytes).toBe(actualBoundaryBytes);
  });

  it("rejects tail_messages above 100 via MCP tool call and direct invocation", async () => {
    const client = await ownerClient();
    const conv = await storeConversation({
      title: "TAIL_BOUND_CHECK",
      messages: [{ role: "user", content: "Test message for tail bound." }],
    });

    // MCP tool call with tail_messages: 101 must fail
    const mcpResult = await callRaw(client, "memory_build_context", {
      task: "Reject tail_messages above 100 via MCP",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "tail",
          tail_messages: 101,
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });
    expect(mcpResult.isError).toBe(true);

    // Direct buildContext invocation with tail_messages: 105 must reject with AppError VALIDATION
    const tenant = await resolveTenant(env, { userId: "owner" });
    await expect(
      buildContext(env, tenant, {
        task: "Reject tail_messages above 100 direct",
        required: [
          {
            selector: { conversation_id: conv.conversation.id },
            mode: "tail",
            tail_messages: 105,
            branch: "active",
            priority: 100,
          },
        ],
        budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining(
        "tail_messages must be an integer between 1 and 100",
      ) as string,
    });

    // Boundary value 100 is accepted and does not fail validation
    const validBoundaryResult = await callContext(client, {
      task: "Accept tail_messages: 100",
      required: [
        {
          selector: { conversation_id: conv.conversation.id },
          mode: "tail",
          tail_messages: 100,
          branch: "active",
          priority: 100,
        },
      ],
      budget: { max_estimated_tokens: 2000, max_serialized_bytes: 20000 },
    });
    expect(validBoundaryResult.status).toBe("complete");
  });
});
