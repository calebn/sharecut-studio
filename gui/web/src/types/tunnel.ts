/** `GET /api/tunnel/status`: what `podcast tunnel` last reported on this computer. */
export type TunnelState = "online" | "connecting" | "reconnecting" | "offline";

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
  attempt: number;
  retry_in_sec: number | null;
};
