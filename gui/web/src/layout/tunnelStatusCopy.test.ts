import { describe, expect, it } from "vitest";
import type { TunnelReasonKind, TunnelState } from "../types/tunnel";
import { tunnelStatusCopy } from "./tunnelStatusCopy";

function status(
  state: TunnelState,
  reasonKind: TunnelReasonKind | null = null,
) {
  return {
    state,
    reason: null,
    reason_kind: reasonKind,
    relay_host: "relay.example.test",
    public_base_url: "https://share.example.test",
    share_count: 2,
    attempt: 0,
    retry_in_sec: null,
  };
}

describe("tunnelStatusCopy", () => {
  it.each([
    [status("online"), "Online", "Guests can open your links."],
    [
      status("connecting"),
      "Connecting",
      "Your links work once this says Online.",
    ],
    [
      status("reconnecting", "network"),
      "Reconnecting",
      "Guests see “Host offline” until this says Online.",
    ],
    [
      status("offline"),
      "Offline",
      "Guests see “Host offline”. Run podcast tunnel on this computer to bring your links online.",
    ],
    [
      status("offline", "auth"),
      "Offline",
      "The relay refused your host token. Check it, then run podcast tunnel again.",
    ],
    [
      status("offline", "config"),
      "Offline",
      "The relay address looks wrong. Check relay_url, then run podcast tunnel again.",
    ],
  ])("words %j for the host", (input, label, detail) => {
    expect(tunnelStatusCopy(input)).toEqual({ label, detail });
  });
});
