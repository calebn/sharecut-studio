/**
 * Generated from podcast_mcp/services/collaboration/share_capabilities.py by scripts/export_roles.py. Do not edit by hand.
 *
 * `CAPABILITIES` are the review and record capability bits. The host is not a
 * role here: it holds every capability, and the document-command capabilities
 * are not in these tables. `roleHolds` is a fixed template, not derived from the
 * source: it matches the listed capabilities exactly and applies no aliases
 * (view => play, comment => reply). That agrees with the server because every
 * table lists both halves of each alias pair; tests/test_export_roles.py pins it.
 */

export const CAPABILITIES = [
  "view",
  "play",
  "comment",
  "reply",
  "action",
  "suggest",
  "edit",
  "mcp",
  "join",
  "monitor",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const REVIEW_ROLE_IDS = ["viewer", "commenter", "editor"] as const;
export type ReviewRole = (typeof REVIEW_ROLE_IDS)[number];

export const RECORD_ROLE_IDS = ["guest", "producer"] as const;
export type RecordPresetRole = (typeof RECORD_ROLE_IDS)[number];

type CapabilityTable<Role extends string> = Readonly<
  Record<Role, readonly Capability[]>
>;

export const REVIEW_ROLE_CAPABILITIES: CapabilityTable<ReviewRole> = {
  viewer: ["play", "view"],
  commenter: ["play", "view", "comment", "reply", "action", "suggest"],
  editor: ["play", "view", "comment", "reply", "action", "suggest", "edit"],
};

export const RECORD_ROLE_CAPABILITIES: CapabilityTable<RecordPresetRole> = {
  guest: ["join", "monitor", "comment"],
  producer: ["monitor", "comment"],
};

export function roleHolds(role: ReviewRole, cap: Capability): boolean {
  return REVIEW_ROLE_CAPABILITIES[role].includes(cap);
}
