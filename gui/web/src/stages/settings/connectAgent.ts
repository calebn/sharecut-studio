import { mcpClientSnippet } from "./hostMcp";

export type AgentClient = "claude" | "cursor" | "other";

export const AGENT_CLIENTS: readonly { id: AgentClient; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "cursor", label: "Cursor" },
  { id: "other", label: "Other" },
];

export function pasteBlock(client: AgentClient, url: string) {
  if (client === "cursor") {
    return { label: "Cursor config", text: mcpClientSnippet(url), rows: 8 };
  }
  return { label: "MCP URL", text: url, rows: 2 };
}

export const NO_EPISODE =
  "Open an episode first. The agent works on the open episode.";
export const NOT_CONNECTED = "Not connected yet";
