import { describe, expect, it } from "vitest";
import {
  extractPointerFromConversation,
  extractPointerFromText,
  isConversationId,
} from "../src/context";
import type { CanonicalConversation, CanonicalNode } from "../src/domain";

describe("deterministic pointer extraction", () => {
  const ID_1 = "0191f6e0-1111-7000-8000-000000000001";
  const ID_2 = "0191f6e0-2222-7000-8000-000000000002";
  const ID_3 = "0191f6e0-3333-7000-8000-000000000003";

  it("validates conversation IDs correctly", () => {
    expect(isConversationId(ID_1)).toBe(true);
    expect(isConversationId(ID_2)).toBe(true);
    expect(isConversationId(ID_3)).toBe(true);
    expect(isConversationId("a".repeat(64))).toBe(true);
    expect(isConversationId("not-a-uuid")).toBe(false);
    expect(isConversationId("")).toBe(false);
  });

  it("extracts current_scene pointer from canonical compact text", () => {
    const text = [
      "[CURRENT / SYNTHETIC EPISODE 1]",
      `active_arc: SYNTHETIC ACTIVE ARC; owner ${ID_3}; status OPEN`,
      `current_scene: ${ID_2}; status OPEN; Headquarters Monday morning; POV Operator; Operations review`,
    ].join("\n");

    const res = extractPointerFromText(text, "current_scene");
    expect(res).toEqual({
      status: "found",
      id: ID_2,
    });
  });

  it("extracts active_arc.owner pointer from canonical compact text", () => {
    const text = [
      "[CURRENT / SYNTHETIC EPISODE 1]",
      `active_arc: SYNTHETIC ACTIVE ARC; owner ${ID_3}; status OPEN`,
      `current_scene: ${ID_2}; status OPEN; Headquarters Monday morning; POV Operator; Operations review`,
    ].join("\n");

    const res = extractPointerFromText(text, "active_arc.owner");
    expect(res).toEqual({
      status: "found",
      id: ID_3,
    });
  });

  it("extracts direct active_arc pointer when owner is specified", () => {
    const text = [`active_arc: SYNTHETIC ACTIVE ARC; owner ${ID_3}; status OPEN`].join("\n");

    const res = extractPointerFromText(text, "active_arc");
    expect(res).toEqual({
      status: "found",
      id: ID_3,
    });
  });

  it("extracts pointer from JSON structured message", () => {
    const text = JSON.stringify({
      current_scene: ID_2,
      active_arc: {
        owner: ID_3,
      },
    });

    expect(extractPointerFromText(text, "current_scene")).toEqual({
      status: "found",
      id: ID_2,
    });

    expect(extractPointerFromText(text, "active_arc.owner")).toEqual({
      status: "found",
      id: ID_3,
    });
  });

  it("returns invalid status when pointer value is not a valid conversation ID", () => {
    const text = "current_scene: malformed-uuid-value; status OPEN";
    const res = extractPointerFromText(text, "current_scene");
    expect(res).toEqual({
      status: "invalid",
      rawValue: "malformed-uuid-value",
    });
  });

  it("returns missing status when pointer field is not present", () => {
    const text = "[CURRENT / SYNTHETIC EPISODE 1]\nsome other content";
    const res = extractPointerFromText(text, "current_scene");
    expect(res).toEqual({
      status: "missing",
    });
  });

  it("returns cleared status when pointer value is explicitly cleared", () => {
    const text1 = "current_scene: none; status OPEN";
    expect(extractPointerFromText(text1, "current_scene")).toEqual({
      status: "cleared",
    });

    const text2 = "current_scene: null; status OPEN";
    expect(extractPointerFromText(text2, "current_scene")).toEqual({
      status: "cleared",
    });

    const text3 = "current_scene: cleared; status OPEN";
    expect(extractPointerFromText(text3, "current_scene")).toEqual({
      status: "cleared",
    });
  });

  const makeNode = (
    sourceNodeId: string,
    parentSourceNodeId: string | null,
    childSourceNodeIds: string[],
    text: string,
  ): CanonicalNode => ({
    id: `id-${sourceNodeId}`,
    sourceNodeId,
    parentSourceNodeId,
    childSourceNodeIds,
    role: "assistant",
    text,
    content: { content_type: "text", parts: [text] },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: null,
    modelSlug: null,
    metadata: {},
    raw: {},
  });

  it("prefers the newer valid pointer across competing JSON messages", () => {
    const conv: CanonicalConversation = {
      id: "test-conv",
      sourceType: "mcp",
      sourceId: "test-conv",
      title: "CURRENT",
      namespace: "test_runtime",
      tags: ["state"],
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      currentSourceNodeId: "n2",
      metadata: {},
      anomalies: [],
      derivedFrom: null,
      nodes: [
        makeNode("n1", null, ["n2"], JSON.stringify({ current_scene: ID_1 })),
        makeNode("n2", "n1", [], JSON.stringify({ current_scene: ID_2 })),
      ],
      activeSourceNodeIds: ["n1", "n2"],
    };

    // Newest message (n2) supersedes older message (n1)
    const res = extractPointerFromConversation(conv, "current_scene");
    expect(res).toEqual({
      status: "found",
      id: ID_2,
    });
  });

  it("does not fall back to older valid JSON when the newer JSON pointer is invalid", () => {
    const conv: CanonicalConversation = {
      id: "test-conv-invalid-authoritative",
      sourceType: "mcp",
      sourceId: "test-conv-2",
      title: "CURRENT",
      namespace: "test_runtime",
      tags: ["state"],
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      currentSourceNodeId: "n2",
      metadata: {},
      anomalies: [],
      derivedFrom: null,
      nodes: [
        makeNode("n1", null, ["n2"], JSON.stringify({ current_scene: ID_1 })),
        makeNode("n2", "n1", [], JSON.stringify({ current_scene: "invalid-uuid-token" })),
      ],
      activeSourceNodeIds: ["n1", "n2"],
    };

    // Newest message (n2) has invalid pointer; must NOT fall back to older valid pointer (n1)
    const res = extractPointerFromConversation(conv, "current_scene");
    expect(res).toEqual({
      status: "invalid",
      rawValue: "invalid-uuid-token",
    });
  });

  it("does not fall back to older valid JSON when the newer JSON pointer is null", () => {
    const conv: CanonicalConversation = {
      id: "test-conv-cleared-authoritative",
      sourceType: "mcp",
      sourceId: "test-conv-3",
      title: "CURRENT",
      namespace: "test_runtime",
      tags: ["state"],
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      currentSourceNodeId: "n2",
      metadata: {},
      anomalies: [],
      derivedFrom: null,
      nodes: [
        makeNode("n1", null, ["n2"], JSON.stringify({ current_scene: ID_1 })),
        makeNode("n2", "n1", [], JSON.stringify({ current_scene: null })),
      ],
      activeSourceNodeIds: ["n1", "n2"],
    };

    // Newest message (n2) explicitly cleared pointer; must NOT fall back to older valid pointer (n1)
    const res = extractPointerFromConversation(conv, "current_scene");
    expect(res).toEqual({
      status: "missing",
    });
  });
});
