/**
 * `GET /api/tunnel/status`: whether guests can reach this computer's links.
 * `not_set_up` is a local-only host (no online sharing settings and no status
 * ever written); the Share dialog shows nothing for it.
 */
export type TunnelState =
  | "online"
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
  | "config"
  | "error";

export type TunnelStatus = {
  state: TunnelState;
  reason: string | null;
  reason_kind: TunnelReasonKind | null;
  relay_host: string | null;
  public_base_url: string | null;
  share_count: number | null;
  /** Wall-clock seconds (Unix epoch) of the next reconnect try while reconnecting. */
  retry_at: number | null;
};
