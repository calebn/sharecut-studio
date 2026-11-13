/**
 * The one-time Role chip hint a guest sees on a shared link (#2298): what the
 * link's role allows, until it is dismissed in that browser. Kept per browser
 * and role, like the other `sharecut.*` conveniences, so a Commenter who is
 * later given an Editor link sees the new sentence once.
 */
import type { ReviewRole } from "../types/roles.generated";
import { readLocal, writeLocal } from "./storage";

export type RoleHintRole = ReviewRole;

export const ROLE_HINT_TEXT: Record<RoleHintRole, string> = {
  viewer: "You can listen along. The host decides.",
  commenter: "You can comment and suggest cuts. The host decides.",
  editor: "You can edit and comment. The host decides what ships.",
};

const key = (role: RoleHintRole) => `sharecut.roleHintSeen.${role}`;

export function roleHintSeen(role: RoleHintRole): boolean {
  return readLocal(key(role)) === "1";
}

export function markRoleHintSeen(role: RoleHintRole): void {
  writeLocal(key(role), "1");
}
