export function branchedChatGptConversation() {
  return {
    id: "chatgpt-conversation-1",
    title: "Database migration decision",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: "assistant-active",
    mapping: {
      root: { id: "root", parent: null, children: ["user-1"], message: null },
      "user-1": {
        id: "user-1",
        parent: "root",
        children: ["assistant-active", "assistant-alt"],
        message: {
          author: { role: "user" },
          create_time: 1_700_000_010,
          content: { content_type: "text", parts: ["Bagaimana migrasi database atlas-db?"] },
          metadata: {},
        },
      },
      "assistant-active": {
        id: "assistant-active",
        parent: "user-1",
        children: [] as string[],
        message: {
          author: { role: "assistant" },
          create_time: 1_700_000_020,
          content: {
            content_type: "text",
            parts: ["Use additive migration 0007 and keep api.internal.example unchanged."],
          },
          metadata: { model_slug: "gpt-example" },
        },
      },
      "assistant-alt": {
        id: "assistant-alt",
        parent: "user-1",
        children: [] as string[],
        message: {
          author: { role: "assistant" },
          content: {
            content_type: "text",
            parts: ["Alternate branch: rebuild atlas-db from scratch."],
          },
          metadata: { unusual: { preserved: true } },
        },
      },
      deleted: {
        id: "deleted",
        parent: null,
        children: [] as string[],
        message: null,
        unexpected_field: "kept in raw",
      },
    },
    plugin_ids: null,
    safe_urls: ["https://example.test"],
  };
}
