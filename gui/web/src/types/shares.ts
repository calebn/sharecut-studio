import { REVIEW_ROLE_IDS, type ReviewRole } from "./roles.generated";

export type ShareRole = ReviewRole;

const ROLE_COPY: Record<ShareRole, { label: string; description: string }> = {
  viewer: {
    label: "Viewer",
    description: "Views and plays the project.",
  },
  commenter: {
    label: "Commenter",
    description:
      "Also comments and suggests edits for you or an Editor to approve.",
  },
  editor: {
    label: "Editor",
    description: "Also edits directly and approves or rejects suggestions.",
  },
};

/** Review-link roles, as in Google Docs; each holds the one before it and more. */
export const REVIEW_ROLES: readonly {
  id: ShareRole;
  label: string;
  description: string;
}[] = REVIEW_ROLE_IDS.map((id) => ({ id, ...ROLE_COPY[id] }));

export type HostShareKind = "review" | "record";

export type HostShareWarning = {
  code: string;
  message: string;
  origin?: string;
  rule?: unknown;
};

export type HostShareRow = {
  token: string;
  url: string | null;
  kind?: HostShareKind;
  docs_role: string | null;
  record_role?: "guest" | "producer" | null;
  session_id?: string | null;
  guest_mode?: string | null;
  mcp_url: string | null;
  usable: boolean;
  invite_closed: boolean | null;
  revoked?: boolean;
  capabilities?: string[];
  review_version_id?: string;
  review_version_label?: string | null;
  follow_latest?: boolean;
  created_at?: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  warnings?: HostShareWarning[];
};

export type HostSharesResponse = {
  shares: HostShareRow[];
  public_origin: string;
};

export type HostRecordRoom = {
  session_id: string;
  guest: HostShareRow;
  producer: HostShareRow;
};

/** A room the server made. */
export type MintedRecordRoom = HostRecordRoom & {
  /** True when the server could not revoke every earlier room's invite links, so some may still work. */
  linksStale: boolean;
};

/** The one usable Viewer link frozen on a version, if the host has made it. */
export function listenRowOf(
  rows: readonly HostShareRow[],
): HostShareRow | undefined {
  return rows.find(
    (row) =>
      row.usable &&
      row.kind !== "record" &&
      row.docs_role === "viewer" &&
      row.follow_latest === false,
  );
}
