export type ShareRole = "viewer" | "commenter" | "editor";

/** Review-link roles, as in Google Docs; each holds the one before it and more. */
export const REVIEW_ROLES: readonly {
  id: ShareRole;
  label: string;
  description: string;
}[] = [
  {
    id: "viewer",
    label: "Viewer",
    description: "Views and plays the project.",
  },
  {
    id: "commenter",
    label: "Commenter",
    description:
      "Also comments and suggests edits for you or an Editor to approve.",
  },
  {
    id: "editor",
    label: "Editor",
    description: "Also edits directly and approves or rejects suggestions.",
  },
];

export type HostShareKind = "review" | "record";

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
  created_at?: string;
  last_used_at?: string | null;
  expires_at?: string | null;
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
