import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMcpConversation } from "../src/chatgpt";
import { AppError } from "../src/errors";
import { getConversationPage } from "../src/retrieval";
import { writeCanonicalConversation } from "../src/storage";
import {
  getOrCreateUser,
  grantNamespace,
  isValidEmail,
  listUserNamespaces,
  normalizeEmail,
  OWNER_DB_USER_ID,
  OWNER_EMAIL,
  OWNER_NAMESPACE,
  OWNER_USER_ID,
  resolveTenant,
  scopeNamespaces,
  userIdForEmail,
} from "../src/tenant";

describe("tenant helpers", () => {
  it("normalizes and validates emails", () => {
    expect(normalizeEmail("  VHIE1046@Gmail.COM ")).toBe("vhie1046@gmail.com");
    expect(isValidEmail("vhie1046@gmail.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });

  it("derives a deterministic user id from the normalized email", async () => {
    expect(await userIdForEmail("vhie1046@gmail.com")).toBe(
      await userIdForEmail("vhie1046@gmail.com"),
    );
    expect(await userIdForEmail("  VHIE1046@Gmail.COM ")).toBe(
      await userIdForEmail("vhie1046@gmail.com"),
    );
    expect(await userIdForEmail("other@example.com")).not.toBe(
      await userIdForEmail("vhie1046@gmail.com"),
    );
  });
});

describe("user provisioning and multi-namespace isolation", () => {
  it("seeds the owner email into the personal namespace", async () => {
    const user = await getOrCreateUser(env, OWNER_EMAIL);
    expect(user.email).toBe(OWNER_EMAIL);
    expect(user.namespace).toBe(OWNER_NAMESPACE);
  });

  it("reuses the same account for case and whitespace variants", async () => {
    const first = await getOrCreateUser(env, "vhie1046@gmail.com");
    const again = await getOrCreateUser(env, "  VHIE1046@Gmail.COM ");
    expect(again.id).toBe(first.id);
    expect(again.namespace).toBe(first.namespace);
  });

  it("gives a new email its own isolated default namespace", async () => {
    const other = await getOrCreateUser(env, "someone-else@example.com");
    expect(other.id).not.toBe(await userIdForEmail(OWNER_EMAIL));
    expect(other.namespace).not.toBe(OWNER_NAMESPACE);
    expect((await listUserNamespaces(env, other.id)).length).toBe(1);
  });

  it("resolves the owner alias and registered users to their namespaces", async () => {
    const owner = await resolveTenant(env, { userId: OWNER_USER_ID });
    expect(owner.userId).toBe(OWNER_DB_USER_ID);
    expect(owner.defaultNamespace).toBe(OWNER_NAMESPACE);
    expect(owner.namespaces).toContain(OWNER_NAMESPACE);

    const other = await getOrCreateUser(env, "someone-else@example.com");
    const resolved = await resolveTenant(env, { userId: other.id });
    expect(resolved.namespaces).toEqual([other.namespace]);
    await expect(resolveTenant(env, { userId: "e".repeat(64) })).rejects.toBeInstanceOf(AppError);
  });

  it("grants additional namespaces to the same user", async () => {
    const other = await getOrCreateUser(env, "someone-else@example.com");
    await grantNamespace(env, other.id, "work");
    expect(await listUserNamespaces(env, other.id)).toContain("work");
  });

  it("allows the same namespace name on another account", async () => {
    const other = await getOrCreateUser(env, "someone-else@example.com");
    await grantNamespace(env, other.id, OWNER_NAMESPACE);
    expect(await listUserNamespaces(env, other.id)).toContain(OWNER_NAMESPACE);
  });

  it("scopes requested namespaces to the caller and rejects foreign ones", async () => {
    const other = await getOrCreateUser(env, "someone-else@example.com");
    await grantNamespace(env, other.id, "work");
    const tenant = await resolveTenant(env, { userId: other.id });
    expect(scopeNamespaces(tenant, "work")).toEqual(["work"]);
    expect(scopeNamespaces(tenant)).toEqual(expect.arrayContaining(["work"]));
    expect(() => scopeNamespaces(tenant, "not-granted-name")).toThrow(AppError);
  });

  it("hides conversations behind another user's namespace", async () => {
    const other = await getOrCreateUser(env, "someone-else@example.com");
    const conversation = await createMcpConversation({
      id: crypto.randomUUID(),
      title: "tenant-scoped",
      namespace: "tenant-a",
      messages: [{ role: "user", content: "secret from tenant-a" }],
    });
    await writeCanonicalConversation(env, conversation, null);

    await expect(
      getConversationPage(env, conversation.id, 0, 20, "active", ["tenant-a"], other.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const own = await getConversationPage(env, conversation.id, 0, 20, "active", ["tenant-a"]);
    expect(own.conversation.title).toBe("tenant-scoped");
  });
});
