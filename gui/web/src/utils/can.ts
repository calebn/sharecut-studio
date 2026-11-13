import {
  type Capability,
  REVIEW_ROLE_CAPABILITIES,
  type ReviewRole,
} from "../types/roles.generated";
import type { StageRole } from "../types/stage";

export const SHARE_PREFIX = "share:";

export function isShareProjectKey(projectPath: string): boolean {
  return projectPath.startsWith(SHARE_PREFIX);
}

/** Who a session acts as: the project's host, or a guest on a share. */
export type Audience = "host" | "guest";

export type CanCtx = {
  readonly projectPath: string;
  /** The session's granted capability strings; the server may send ones outside the table. `null` is none. */
  readonly capabilities?: readonly string[] | null;
};

/** Mirrors ``has_capability`` (view => play, comment => reply) over the raw grants. */
export function holds(
  grants: readonly string[] | null | undefined,
  cap: string,
): boolean {
  const set = new Set(grants ?? []);
  if (cap === "play" && set.has("view")) return true;
  if (cap === "reply" && set.has("comment")) return true;
  return set.has(cap);
}

export function isHost(ctx: Pick<CanCtx, "projectPath">): boolean {
  return !isShareProjectKey(ctx.projectPath);
}

export function can(cap: Capability, ctx: CanCtx): boolean {
  if (isHost(ctx)) return true;
  return holds(ctx.capabilities, cap);
}

/** What a review role grants by its table, for places that know a role and no grants. */
export function roleCan(role: ReviewRole, cap: Capability): boolean {
  return holds(REVIEW_ROLE_CAPABILITIES[role], cap);
}

export function isHostRole(role: StageRole): role is "host" {
  return role === "host";
}

export function canEditStage(role: StageRole): boolean {
  return !isHostRole(role) && roleCan(role, "edit");
}

export function isGuestAudience(audience: Audience): boolean {
  return audience === "guest";
}

export function isAudience(value: unknown): value is Audience {
  return value === "host" || value === "guest";
}

export function audienceOf(
  projectPath: string,
  guestMode: string | null,
  guestShare = false,
): Audience {
  return guestShare || Boolean(guestMode) || isShareProjectKey(projectPath)
    ? "guest"
    : "host";
}
