import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../plugins/mempersist");
const pluginPath = resolve(packageRoot, "plugin.json");
const mcpPath = resolve(packageRoot, "mcp.json");
const skillPaths = [
  resolve(packageRoot, "skills/memory-workflows/SKILL.md"),
  resolve(packageRoot, "skills/get-started/SKILL.md"),
];
const logoPath = resolve(packageRoot, "assets/logo.svg");

const requiredInterfaceUrls = {
  websiteURL: "https://mempersist.codifiedtech.id/",
  supportURL: "https://github.com/ravhirizaldi/mempersist/issues",
  privacyPolicyURL: "https://mempersist.codifiedtech.id/privacy",
  termsOfServiceURL: "https://mempersist.codifiedtech.id/terms",
} as const;

const memoryTools: Record<string, true> = {
  memory_search: true,
  memory_get_context: true,
  memory_get_conversation: true,
  memory_get_conversations: true,
  memory_get_messages: true,
  memory_list_conversations: true,
  memory_list_revisions: true,
  memory_resolve_conversations: true,
  memory_build_context: true,
  memory_store: true,
  memory_commit_batch: true,
  memory_upsert_messages: true,
  memory_append: true,
  memory_replace: true,
  memory_edit_messages: true,
  memory_restore_revision: true,
  memory_copy_conversations: true,
  memory_update_tags: true,
  memory_delete_conversations: true,
  memory_empty_namespace: true,
  memory_list_namespaces: true,
  memory_stats: true,
  memory_import_status: true,
  memory_get_capabilities: true,
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): JsonObject {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isJsonObject(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value;
}

function objectProperty(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  if (!isJsonObject(value)) {
    throw new Error(`${key} must be a JSON object`);
  }
  return value;
}

function stringProperty(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function caseText(testCase: JsonObject): string {
  return Object.values(testCase)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

describe("MemPersist Agent Plugin package", () => {
  it("parses portable plugin and MCP manifests", () => {
    const plugin = readJson(pluginPath);
    const mcp = readJson(mcpPath);

    expect(plugin["$schema"]).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(plugin.name).toBe("mempersist");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.repository).toBe("https://github.com/ravhirizaldi/mempersist");
    expect(objectProperty(plugin, "author").name).toBe("Ravhi Rizaldi");
    expect(mcp["$schema"]).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  });
  it("keeps portable archive files at the archive root", () => {
    expect(relative(packageRoot, pluginPath)).toBe("plugin.json");
    expect(relative(packageRoot, mcpPath)).toBe("mcp.json");
    expect(relative(packageRoot, logoPath)).toBe("assets/logo.svg");
  });

  it("configures exactly one streamable HTTP MCP server at the public endpoint", () => {
    const servers = objectProperty(readJson(mcpPath), "mcpServers");
    expect(Object.keys(servers)).toEqual(["mempersist"]);

    const server = objectProperty(servers, "mempersist");
    expect(server.type).toBe("streamable-http");
    expect(server.url).toBe("https://mempersist.codifiedtech.id/mcp");
  });

  it("keeps OpenAI interface metadata and URLs factual", () => {
    const plugin = readJson(pluginPath);
    const openai = objectProperty(objectProperty(plugin, "extensions"), "com.openai");
    const interfaceMetadata = objectProperty(openai, "interface");

    expect(interfaceMetadata.displayName).toBe("MemPersist");
    expect(interfaceMetadata.developerName).toBe("Ravhi Rizaldi");
    expect(interfaceMetadata.category).toBe("Productivity");
    expect(typeof interfaceMetadata.shortDescription).toBe("string");
    expect(stringProperty(interfaceMetadata, "shortDescription").length).toBeLessThanOrEqual(30);
    expect(typeof interfaceMetadata.longDescription).toBe("string");
    expect(Object.prototype.hasOwnProperty.call(interfaceMetadata, "capabilities")).toBe(true);
    expect(interfaceMetadata.logo).toBe("./assets/logo.svg");
    expect(interfaceMetadata.composerIcon).toBe("./assets/logo.svg");

    for (const [field, url] of Object.entries(requiredInterfaceUrls)) {
      expect(interfaceMetadata[field]).toBe(url);
    }

    const prompts = interfaceMetadata.defaultPrompt;
    expect(Array.isArray(prompts)).toBe(true);
    expect((prompts as unknown[]).length).toBeLessThanOrEqual(3);
    expect(prompts).toEqual(expect.arrayContaining([expect.any(String)]));
  });
  it("keeps referenced assets and onboarding skills inside package", () => {
    const plugin = readJson(pluginPath);
    const openai = objectProperty(objectProperty(plugin, "extensions"), "com.openai");
    const interfaceMetadata = objectProperty(openai, "interface");
    expect(openai.onboardingSkill).toBe("./skills/get-started/SKILL.md");
    expect(existsSync(logoPath)).toBe(true);
    expect(existsSync(resolve(packageRoot, stringProperty(interfaceMetadata, "logo")))).toBe(true);
    expect(
      existsSync(resolve(packageRoot, stringProperty(interfaceMetadata, "composerIcon"))),
    ).toBe(true);
    expect(existsSync(resolve(packageRoot, stringProperty(openai, "onboardingSkill")))).toBe(true);
  });

  it("requires name and description in every packaged skill frontmatter", () => {
    for (const path of skillPaths) {
      const contents = readFileSync(path, "utf8");
      const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s|$)/u.exec(contents)?.[1];
      expect(frontmatter, `${path} frontmatter`).toBeDefined();
      expect(frontmatter).toMatch(/^name:\s*\S.+$/mu);
      expect(frontmatter).toMatch(/^description:\s*\S.+$/mu);
    }
  });

  it("contains exactly five positive and three negative review cases", () => {
    const plugin = readJson(pluginPath);
    const openai = objectProperty(objectProperty(plugin, "extensions"), "com.openai");
    const review = objectProperty(openai, "review");
    expect(review).not.toHaveProperty("demo_recording_url");
    const testCases = objectProperty(review, "test_cases");
    const positive = testCases.positive;
    const negative = testCases.negative;

    expect(Array.isArray(positive)).toBe(true);
    expect(Array.isArray(negative)).toBe(true);
    expect((positive as unknown[]).length).toBe(5);
    expect((negative as unknown[]).length).toBe(3);

    for (const value of positive as unknown[]) {
      const testCase = isJsonObject(value) ? value : {};
      expect(stringProperty(testCase, "description")).not.toBe("");
      expect(stringProperty(testCase, "prompt")).not.toBe("");
      const tools = stringProperty(testCase, "tools_triggered")
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(memoryTools[tool]).toBe(true);
      }
      expect(stringProperty(testCase, "expected_behavior")).not.toBe("");
    }

    for (const value of negative as unknown[]) {
      const testCase = isJsonObject(value) ? value : {};
      expect(stringProperty(testCase, "description")).not.toBe("");
      expect(stringProperty(testCase, "prompt")).not.toBe("");
      expect(stringProperty(testCase, "expected_behavior")).not.toBe("");
    }

    const negativeText = (negative as unknown[]).filter(isJsonObject).map(caseText);
    expect(
      negativeText.some((text) => /automatic|full[- ]chat|capture|intercept/iu.test(text)),
    ).toBe(true);
    expect(
      negativeText.some((text) =>
        /unauthori[sz]ed|other account|another account|different account/iu.test(text),
      ),
    ).toBe(true);
    expect(
      negativeText.some((text) => /unconfirm|without confirmation|destructive|delet/iu.test(text)),
    ).toBe(true);
  });

  it("rejects placeholder and fake-domain strings across package files", () => {
    const paths = [pluginPath, mcpPath, logoPath, ...skillPaths];
    for (const path of paths) {
      expect(readFileSync(path, "utf8")).not.toMatch(/example\.com|todo|placeholder/iu);
    }
  });
});
