export type ShareRole = "viewer" | "commenter" | "editor";

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
