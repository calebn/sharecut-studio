import type { TunnelStatus } from "../types/tunnel";

export const ONLINE_SHARING_GUIDE_URL =
  "https://github.com/calebn/sharecut-studio/blob/main/docs/host-online-relay.md#tunnel-status";

export type TunnelTone = "ok" | "pending" | "problem" | "neutral";

export type TunnelStatusCopy = {
  tone: TunnelTone;
  headline: string;
  /** The next step in plain words, behind a disclosure so the headline stays a consequence. */
  fix?: { summary: string; body: string };
};

const OFFLINE_FIX: Record<"auth" | "config" | "other", string> = {
  auth: "Your sharing service refused this computer's access key. Get a new key from whoever runs the service, then start online sharing again.",
  config:
    "The sharing service address in your settings looks wrong. Correct it, then start online sharing again.",
  other:
    "Check that this computer is awake and connected to the internet. If online sharing stopped, start it again.",
};

/** Host-facing words for online sharing: what guests experience, with the fix tucked away. */
export function tunnelStatusCopy(
  status: TunnelStatus,
): TunnelStatusCopy | null {
  switch (status.state) {
    case "online":
      return { tone: "ok", headline: "Guests can open your links" };
    case "connecting":
      return {
        tone: "pending",
        headline: "Connecting… guests can open your links once you're online",
      };
    case "reconnecting":
      return {
        tone: "pending",
        headline: "Reconnecting… guests may see a brief interruption",
      };
    case "offline": {
      const kind =
        status.reason_kind === "auth" || status.reason_kind === "config"
          ? status.reason_kind
          : "other";
      return {
        tone: "problem",
        headline:
          "Not reachable online: guests can't open links until you're back online",
        fix: { summary: "How to fix", body: OFFLINE_FIX[kind] },
      };
    }
    case "off":
      return {
        tone: "neutral",
        headline: "Online sharing is off",
        fix: {
          summary: "How to turn it on",
          body: "Start online sharing on this computer and keep it running while guests use your links.",
        },
      };
    case "not_set_up":
      return null;
  }
}

/** "Trying again in 5 s" until `retryAtSec`, then "Trying again now". */
export function retryCountdown(retryAtSec: number, nowMs: number): string {
  const remaining = Math.ceil(retryAtSec - nowMs / 1000);
  if (remaining <= 0) {
    return "Trying again now";
  }
  if (remaining < 120) {
    return `Trying again in ${remaining} s`;
  }
  return `Trying again in ${Math.round(remaining / 60)} min`;
}

/** Reduced-motion wording: the clock time of the next try, which never ticks. */
export function retryAtClock(retryAtSec: number): string {
  const time = new Date(retryAtSec * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  return `Next try at ${time}`;
}
