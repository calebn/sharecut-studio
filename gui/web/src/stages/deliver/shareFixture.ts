import type { HostShareRow } from "../../types/shares";
import type { TunnelStatus } from "../../types/tunnel";
import type { ShareOptions } from "./shareLogic";

function hostShareRow(overrides: Partial<HostShareRow> = {}): HostShareRow {
  return {
    token: "sample-review-link",
    url: "http://127.0.0.1:8765/r/sample-review-link",
    kind: "review",
    docs_role: "commenter",
    mcp_url: null,
    usable: true,
    invite_closed: overrides.kind === "record" ? false : null,
    review_version_label: "Share mix",
    follow_latest: true,
    last_used_at: null,
    ...overrides,
  };
}

export const REVIEW_ROW = hostShareRow({
  token: "sample-review-link",
  last_used_at: "2026-09-05T12:00:00Z",
});

export const AGENT_ROW = hostShareRow({
  token: "sample-agent-link",
  url: "http://127.0.0.1:8765/r/sample-agent-link",
  docs_role: "editor",
  mcp_url: "http://127.0.0.1:8765/r/sample-agent-link/mcp",
  review_version_label: null,
});

export const GUEST_ROW = hostShareRow({
  token: "sample-guest-link",
  url: "http://127.0.0.1:8765/r/sample-guest-link",
  kind: "record",
  docs_role: null,
  record_role: "guest",
  session_id: "sample-room",
  created_at: "2026-09-05T10:00:00Z",
});

export const PRODUCER_ROW = hostShareRow({
  token: "sample-producer-link",
  url: "http://127.0.0.1:8765/r/sample-producer-link",
  kind: "record",
  docs_role: null,
  record_role: "producer",
  session_id: "sample-room",
});

export const REVOKED_ROW = hostShareRow({
  token: "sample-stale-link",
  usable: false,
});

export const ONLINE: TunnelStatus = {
  state: "online",
  reason: null,
  reason_kind: null,
  relay_host: "relay.example.test",
  public_base_url: "https://share.example.test",
  share_count: 2,
  retry_at: null,
};

/** The Share section's options with every callback made by `mock`. */
export function shareOptions(
  mock: () => () => void,
  overrides: Partial<ShareOptions> = {},
): ShareOptions {
  return {
    role: "commenter",
    onRole: mock(),
    withMcp: false,
    onWithMcp: mock(),
    freeze: false,
    onFreeze: mock(),
    rows: [],
    busy: false,
    createRecovery: { kind: "idle" },
    error: null,
    status: null,
    copiedKey: null,
    lastCreated: null,
    onCreate: mock(),
    onRefreshMix: mock(),
    onCreateRecord: mock(),
    onCopy: mock(),
    onRevoke: mock(),
    onEndRoom: mock(),
    onReplaceRecordInvite: mock(),
    onOpenRoomPanel: mock(),
    ...overrides,
  };
}
