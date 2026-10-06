import type { TunnelStatus } from "../types/tunnel";

export type TunnelStatusCopy = { label: string; detail: string };

/** Host-facing words for the tunnel state: what guests see, and the fix when there is one. */
export function tunnelStatusCopy(status: TunnelStatus): TunnelStatusCopy {
  switch (status.state) {
    case "online":
      return { label: "Online", detail: "Guests can open your links." };
    case "connecting":
      return {
        label: "Connecting",
        detail: "Your links work once this says Online.",
      };
    case "reconnecting":
      return {
        label: "Reconnecting",
        detail: "Guests see “Host offline” until this says Online.",
      };
    case "offline":
      if (status.reason_kind === "auth") {
        return {
          label: "Offline",
          detail:
            "The relay refused your host token. Check it, then run podcast tunnel again.",
        };
      }
      if (status.reason_kind === "config") {
        return {
          label: "Offline",
          detail:
            "The relay address looks wrong. Check relay_url, then run podcast tunnel again.",
        };
      }
      return {
        label: "Offline",
        detail:
          "Guests see “Host offline”. Run podcast tunnel on this computer to bring your links online.",
      };
  }
}
