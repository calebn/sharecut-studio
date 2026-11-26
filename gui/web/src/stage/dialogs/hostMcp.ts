/** Local host Streamable HTTP MCP URL (the running DAW, not a share token). */

export function localHostMcpUrl(
  loc: Pick<Location, "protocol" | "hostname" | "port"> = window.location,
): string {
  const port = loc.port === "5173" || loc.port === "" ? "8765" : loc.port;
  return `http://127.0.0.1:${port}/mcp`;
}

export function mcpClientSnippet(url: string): string {
  return JSON.stringify({ mcpServers: { sharecut: { url } } }, null, 2);
}

/** One message for every copy failure; the recovery is the same and the browser text is not for people. */
export const COPY_FAILED_MESSAGE =
  "Couldn't copy. Select the text and copy it by hand.";
