import { describe, expect, it } from "vitest";
import type {
  TunnelReasonKind,
  TunnelState,
  TunnelStatus,
} from "../types/tunnel";
import {
  retryAtClock,
  retryCountdown,
  tunnelStatusCopy,
} from "./tunnelStatusCopy";

function status(
  state: TunnelState,
  reasonKind: TunnelReasonKind | null = null,
): TunnelStatus {
  return {
    state,
    reason: reasonKind ? `${reasonKind}: detail` : null,
    reason_kind: reasonKind,
    relay_host: "relay.example.test",
    public_base_url: "https://share.example.test",
    share_count: 2,
    retry_at: null,
  };
}

const NOT_REACHABLE =
  "Not reachable online: guests can't open links until you're back online";

describe("tunnelStatusCopy", () => {
  it.each([
    [
      "online",
      status("online"),
      { tone: "ok", headline: "Guests can open your links" },
    ],
    [
      "connecting",
      status("connecting"),
      {
        tone: "pending",
        headline: "Connecting… guests can open your links once you're online",
      },
    ],
    [
      "reconnecting",
      status("reconnecting", "network"),
      {
        tone: "pending",
        headline: "Reconnecting… guests may see a brief interruption",
      },
    ],
    [
      "offline after a dropped connection",
      status("offline", "network"),
      {
        tone: "problem",
        headline: NOT_REACHABLE,
        fix: {
          summary: "How to fix",
          body: "Check that this computer is awake and connected to the internet. If online sharing stopped, start it again.",
        },
      },
    ],
    [
      "offline after it stopped responding",
      status("offline"),
      {
        tone: "problem",
        headline: NOT_REACHABLE,
        fix: {
          summary: "How to fix",
          body: "Check that this computer is awake and connected to the internet. If online sharing stopped, start it again.",
        },
      },
    ],
    [
      "offline with a refused access key",
      status("offline", "auth"),
      {
        tone: "problem",
        headline: NOT_REACHABLE,
        fix: {
          summary: "How to fix",
          body: "Your sharing service refused this computer's access key. Get a new key from whoever runs the service, then start online sharing again.",
        },
      },
    ],
    [
      "offline with a wrong address",
      status("offline", "config"),
      {
        tone: "problem",
        headline: NOT_REACHABLE,
        fix: {
          summary: "How to fix",
          body: "The sharing service address in your settings looks wrong. Correct it, then start online sharing again.",
        },
      },
    ],
    [
      "off",
      status("off"),
      {
        tone: "neutral",
        headline: "Online sharing is off",
        fix: {
          summary: "How to turn it on",
          body: "Start online sharing on this computer and keep it running while guests use your links.",
        },
      },
    ],
  ])("words the %s state for the host", (_name, input, expected) => {
    expect(tunnelStatusCopy(input)).toEqual(expected);
  });

  it("says nothing to a local-only host", () => {
    expect(tunnelStatusCopy(status("not_set_up"))).toBeNull();
  });

  it("never shows mechanism words or commands", () => {
    const states: TunnelState[] = [
      "online",
      "connecting",
      "reconnecting",
      "offline",
      "off",
    ];
    const kinds: (TunnelReasonKind | null)[] = [null, "auth", "config"];
    const text = states
      .flatMap((s) =>
        kinds.map((k) => JSON.stringify(tunnelStatusCopy(status(s, k)))),
      )
      .join(" ");
    for (const banned of [
      /relay/i,
      /host token/i,
      /relay_url/,
      /podcast tunnel/,
      /tunnel/i,
      /Host offline/,
    ]) {
      expect(text).not.toMatch(banned);
    }
  });
});

describe("retry wording", () => {
  const retryAt = 1_000;

  it("counts down in seconds, then says it is trying now", () => {
    expect(retryCountdown(retryAt, 995_000)).toBe("Trying again in 5 s");
    expect(retryCountdown(retryAt, 999_200)).toBe("Trying again in 1 s");
    expect(retryCountdown(retryAt, 1_000_000)).toBe("Trying again now");
    expect(retryCountdown(retryAt, 1_003_000)).toBe("Trying again now");
  });

  it("keeps seconds through the longest backoff, then rounds to minutes", () => {
    expect(retryCountdown(retryAt, 925_000)).toBe("Trying again in 75 s");
    expect(retryCountdown(retryAt, 820_000)).toBe("Trying again in 3 min");
  });

  it("gives a clock time for reduced motion", () => {
    expect(retryAtClock(retryAt)).toMatch(/^Next try at \d{1,2}:\d{2}:\d{2}/);
  });
});
