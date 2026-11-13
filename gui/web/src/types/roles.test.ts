import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CAPABILITIES,
  RECORD_ROLE_CAPABILITIES,
  RECORD_ROLE_IDS,
  REVIEW_ROLE_CAPABILITIES,
  REVIEW_ROLE_IDS,
  type ReviewRole,
  roleHolds,
} from "./roles.generated";
import { REVIEW_ROLES, type ShareRole } from "./shares";

describe("generated roles", () => {
  it("makes each review role a strict superset of the one before", () => {
    for (let i = 1; i < REVIEW_ROLE_IDS.length; i++) {
      const lower = REVIEW_ROLE_CAPABILITIES[REVIEW_ROLE_IDS[i - 1]];
      const higher = REVIEW_ROLE_CAPABILITIES[REVIEW_ROLE_IDS[i]];
      for (const cap of lower) expect(higher).toContain(cap);
      expect(higher.length).toBeGreaterThan(lower.length);
    }
  });

  it("lists only known capabilities, once each", () => {
    for (const caps of [
      ...Object.values(REVIEW_ROLE_CAPABILITIES),
      ...Object.values(RECORD_ROLE_CAPABILITIES),
    ]) {
      expect(new Set(caps).size).toBe(caps.length);
      for (const cap of caps) expect(CAPABILITIES).toContain(cap);
    }
  });

  it("keeps review and record role ids disjoint", () => {
    for (const id of RECORD_ROLE_IDS) {
      expect(REVIEW_ROLE_IDS as readonly string[]).not.toContain(id);
    }
  });

  it("labels every review role in order", () => {
    expect(REVIEW_ROLES.map((role) => role.id)).toEqual([...REVIEW_ROLE_IDS]);
  });

  it("derives ShareRole from the generated ReviewRole", () => {
    expectTypeOf<ShareRole>().toEqualTypeOf<ReviewRole>();
    expectTypeOf<ShareRole>().toEqualTypeOf<(typeof REVIEW_ROLE_IDS)[number]>();
  });

  it("answers roleHolds from the review table", () => {
    expect(roleHolds("viewer", "view")).toBe(true);
    expect(roleHolds("viewer", "comment")).toBe(false);
    expect(roleHolds("commenter", "suggest")).toBe(true);
    expect(roleHolds("commenter", "edit")).toBe(false);
    expect(roleHolds("editor", "edit")).toBe(true);
    for (const role of REVIEW_ROLE_IDS) {
      expect(roleHolds(role, "mcp")).toBe(false);
    }
  });
});
