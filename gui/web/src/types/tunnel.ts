/**
 * `GET /api/tunnel/status`: whether guests can reach this computer's links.
 * `not_set_up` is a local-only host (no online sharing settings and no status
 * ever written); the Invite sheet shows nothing for it.
 */
export type TunnelState =
  | "online"
  | "limited"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "off"
  | "not_set_up";

export type TunnelReasonKind =
  | "network"
  | "timeout"
  | "relay closed"
  | "rate limited"
  | "auth"
  | "unavailable"
  | "config"
  | "error";

/** What the sharing service holds back while online sharing is connected. */
export type TunnelLimit = "shares" | "bandwidth";

export type TunnelStatus = {
  state: TunnelState;
  reason: string | null;
  reason_kind: TunnelReasonKind | null;
  /** Set while `state` is `limited`. */
  limit?: TunnelLimit | null;
  /** Where to report a problem; the Help dialog's link. */
  support_url?: string;
  relay_host: string | null;
  public_base_url: string | null;
  share_count: number | null;
  /** Wall-clock seconds (Unix epoch) of the next reconnect try while reconnecting. */
  retry_at: number | null;
};
