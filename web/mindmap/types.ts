/** Copy contract shared between the Worker HTML and the bundled browser client. */
export interface MindmapClientCopy {
  accountLabel: string;
  conversationsLabel: string;
  emptyLabel: string;
  failedLabel: string;
  loadingLabel: string;
}

export interface MindmapClientConversation {
  id: string;
  namespace: string;
  title: string;
  tags: string[];
  updated_at: string | null;
}

export interface MindmapClientPayload {
  namespaces: Array<{ namespace: string; conversations: number }>;
  conversations: MindmapClientConversation[];
  nextCursor: string | null;
}
