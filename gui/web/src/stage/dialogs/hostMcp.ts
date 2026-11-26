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

/** The setup guide on the docs site (one link; the hash router has no section anchors). */
export const MCP_SETUP_GUIDE_URL = "https://docs.sharecut.studio/#/mcp-setup";

export const ACTIVITY_POLL_MS = 3000;
/** How often the minutes count up between answers. */
export const ACTIVITY_TICK_MS = 15_000;
/** Up to this age an app "used this address"; after it the line says "Last used". */
export const RECENT_MAX_SECONDS = 600;

export const UNAVAILABLE_MESSAGE =
  "Connecting an app isn't available here. This copy of ShareCut Studio isn't set up to accept connections from other apps on this computer.";

/** What the host last said about the address. `receivedAt` is `performance.now()`, immune to clock changes. */
export type ActivityState =
  | { kind: "unknown" }
  | { kind: "unavailable" }
  | { kind: "never" }
  | { kind: "used"; ageAtReceipt: number; receivedAt: number };

export type ActivityClass =
  | "unknown"
  | "unavailable"
  | "never"
  | "recent"
  | "stale";

export function activityFromResponse(
  r: { mounted: boolean; age_seconds: number | null },
  now: number,
): ActivityState {
  if (!r.mounted) return { kind: "unavailable" };
  if (r.age_seconds === null) return { kind: "never" };
  return { kind: "used", ageAtReceipt: r.age_seconds, receivedAt: now };
}

function ageSeconds(s: Extract<ActivityState, { kind: "used" }>, now: number) {
  return s.ageAtReceipt + Math.max(0, Math.floor((now - s.receivedAt) / 1000));
}

export function activityClass(s: ActivityState, now: number): ActivityClass {
  if (s.kind !== "used") return s.kind;
  return ageSeconds(s, now) <= RECENT_MAX_SECONDS ? "recent" : "stale";
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** The status sentence, or null when there is nothing to say yet. Never says "connected". */
export function activityText(s: ActivityState, now: number): string | null {
  switch (s.kind) {
    case "unknown":
      return null;
    case "unavailable":
      return UNAVAILABLE_MESSAGE;
    case "never":
      return "No app has used this address since Studio started.";
    case "used": {
      const age = ageSeconds(s, now);
      const minutes = Math.floor(age / 60);
      if (age <= RECENT_MAX_SECONDS) {
        return minutes < 1
          ? "An app used this address just now."
          : `An app used this address ${plural(minutes, "minute")} ago.`;
      }
      if (age < 3600) return `Last used ${plural(minutes, "minute")} ago.`;
      if (age < 86_400) {
        return `Last used ${plural(Math.floor(age / 3600), "hour")} ago.`;
      }
      return `Last used ${plural(Math.floor(age / 86_400), "day")} ago.`;
    }
  }
}
