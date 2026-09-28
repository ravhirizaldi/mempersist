/** Copy contract shared between the Worker HTML and the bundled browser client. */
export interface MindmapClientCopy {
  accountLabel: string;
  conversationsLabel: string;
  emptyLabel: string;
  failedLabel: string;
  loadingLabel: string;
  messagesLabel: string;
  moreLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
}

export interface MindmapClientConversation {
  id: string;
  namespace: string;
  title: string;
  tags: string[];
  updated_at: string | null;
  messages: number;
}

export interface MindmapClientPayload {
  namespaces: Array<{ namespace: string; conversations: number }>;
  conversations: MindmapClientConversation[];
  nextCursor: string | null;
}
