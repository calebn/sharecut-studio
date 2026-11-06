import type { ReactNode } from "react";
import { ListenLinkRow } from "../../stage/frame/invite/ListenLinkRow";
import type { TunnelStatus } from "../../types/tunnel";
import { shareOptionsFixture } from "./shareFixture";
import { LISTEN_CHOICES, shareCopyKey } from "./shareLogic";

/** What a Deliver story or test says about the host's Listen link row. */
export type ListenFixture = {
  url: string | null;
  copyState?: "idle" | "copied" | "blocked";
  /** The mix is missing: the row offers Refresh mix. */
  noMix?: boolean;
  /** `network`: only people on this network can open the link. */
  reach?: "anywhere" | "network";
  onCopy?: () => void;
  onRefreshMix?: () => void;
};

const TOKEN = "ls-1";

const tunnel = (state: TunnelStatus["state"]): TunnelStatus => ({
  state,
  reason: null,
  reason_kind: null,
  relay_host: "relay.example.test",
  public_base_url: "https://share.example.test",
  share_count: 1,
  retry_at: null,
});

/** The `listen` render prop Deliver's host passes, built from a few plain fields. */
export function listenOf(
  fixture: ListenFixture,
): (state: { highlight: boolean; phone: boolean }) => ReactNode {
  const key = shareCopyKey("link", TOKEN);
  const options = shareOptionsFixture({
    rows: fixture.url
      ? [
          {
            token: TOKEN,
            url: fixture.url,
            kind: "review",
            docs_role: "viewer",
            mcp_url: null,
            usable: true,
            invite_closed: null,
            review_version_label: "Rough cut",
            follow_latest: false,
            last_used_at: null,
          },
        ]
      : [],
    copiedKey: fixture.copyState === "copied" ? key : null,
    blockedKey: fixture.copyState === "blocked" ? key : null,
    recovery: fixture.noMix
      ? {
          kind: "needs_refresh",
          message: "Refresh the mix to create the link.",
          refreshError: null,
        }
      : { kind: "idle" },
    refreshFor: fixture.noMix
      ? { choices: LISTEN_CHOICES, listen: true }
      : null,
    tunnel: fixture.reach
      ? tunnel(fixture.reach === "network" ? "off" : "online")
      : undefined,
    onCreate: () => fixture.onCopy?.(),
    onCopy: () => fixture.onCopy?.(),
    onRefreshMix: () => fixture.onRefreshMix?.(),
  });
  return ({ highlight, phone }) => (
    <ListenLinkRow options={options} highlight={highlight} compact={phone} />
  );
}
