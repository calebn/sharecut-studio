import { describe, expect, it } from "vitest";
import {
  canApplyPass12,
  canApplyStructural,
  canComment,
  canEditEnvelopes,
  canEditMix,
  canHostMutate,
  canIngestMedia,
  canManageProjects,
  canRefreshMix,
  canReply,
  canSetAction,
  canSuggestStructural,
} from "../shareMode";
import { landingStage, stageRoleOf, stagesForRole } from "../state/stageRoutes";
import {
  CAPABILITIES,
  type Capability,
  REVIEW_ROLE_CAPABILITIES,
  REVIEW_ROLE_IDS,
  type ReviewRole,
} from "../types/roles.generated";
import {
  audienceOf,
  can,
  canEditStage,
  holds,
  isAudience,
  isGuestAudience,
  isHost,
  isHostRole,
  roleCan,
} from "./can";

const SHARE = "share:tok";
const HOST = "/projects/ep";

/** Pinned from share_capabilities.py so a drift in both the generator and can() still fails. */
const GRID: Record<ReviewRole, readonly Capability[]> = {
  viewer: ["view", "play"],
  commenter: ["view", "play", "comment", "reply", "action", "suggest"],
  editor: ["view", "play", "comment", "reply", "action", "suggest", "edit"],
};

function oracle(role: ReviewRole, cap: Capability): boolean {
  const table = REVIEW_ROLE_CAPABILITIES[role];
  return (
    table.includes(cap) ||
    (cap === "play" && table.includes("view")) ||
    (cap === "reply" && table.includes("comment"))
  );
}

describe("can truth table", () => {
  for (const role of REVIEW_ROLE_IDS) {
    for (const cap of CAPABILITIES) {
      it(`${role} ${cap}`, () => {
        const expected = GRID[role].includes(cap);
        expect(oracle(role, cap)).toBe(expected);
        expect(
          can(cap, {
            projectPath: SHARE,
            capabilities: REVIEW_ROLE_CAPABILITIES[role],
          }),
        ).toBe(expected);
        expect(roleCan(role, cap)).toBe(expected);
      });
    }
  }

  it("host holds every capability whatever the grants", () => {
    for (const cap of CAPABILITIES) {
      expect(can(cap, { projectPath: HOST, capabilities: null })).toBe(true);
      expect(can(cap, { projectPath: HOST, capabilities: [] })).toBe(true);
      expect(can(cap, { projectPath: HOST, capabilities: ["view"] })).toBe(
        true,
      );
    }
    expect(isHost({ projectPath: HOST })).toBe(true);
    expect(isHost({ projectPath: SHARE })).toBe(false);
  });

  it("a share with no grants holds nothing", () => {
    for (const cap of CAPABILITIES) {
      expect(can(cap, { projectPath: SHARE })).toBe(false);
      expect(can(cap, { projectPath: SHARE, capabilities: null })).toBe(false);
      expect(can(cap, { projectPath: SHARE, capabilities: [] })).toBe(false);
    }
  });

  it("applies the server aliases one way", () => {
    expect(holds(["view"], "play")).toBe(true);
    expect(holds(["comment"], "reply")).toBe(true);
    expect(holds(["play"], "view")).toBe(false);
    expect(holds(["reply"], "comment")).toBe(false);
  });

  it("tolerates capability strings outside the table", () => {
    const capabilities = ["mcp", "join", "monitor", "zzz"];
    expect(can("mcp", { projectPath: SHARE, capabilities })).toBe(true);
    expect(can("join", { projectPath: SHARE, capabilities })).toBe(true);
    expect(can("edit", { projectPath: SHARE, capabilities })).toBe(false);
    expect(holds(capabilities, "zzz")).toBe(true);
  });

  it("roles hold no guest-only cap beyond their table", () => {
    for (const role of REVIEW_ROLE_IDS) {
      for (const cap of ["mcp", "join", "monitor"] as const) {
        expect(roleCan(role, cap)).toBe(false);
      }
    }
  });
});

describe("audience", () => {
  it("is a guest on a share key, a guest mode or a guest share", () => {
    expect(audienceOf(HOST, null)).toBe("host");
    expect(audienceOf(SHARE, null)).toBe("guest");
    expect(audienceOf(HOST, "view")).toBe("guest");
    expect(audienceOf(HOST, null, true)).toBe("guest");
    expect(isGuestAudience("guest")).toBe(true);
    expect(isGuestAudience("host")).toBe(false);
  });

  it("names the two audiences and nothing else", () => {
    expect(isAudience("host")).toBe(true);
    expect(isAudience("guest")).toBe(true);
    expect(isAudience("x")).toBe(false);
    expect(isAudience(null)).toBe(false);
    expect(isHostRole("host")).toBe(true);
    expect(isHostRole("editor")).toBe(false);
  });
});

describe("stage access", () => {
  it("gives a host stage role only to a session with no guest mode", () => {
    for (const mode of [null, "view", "comment", "edit", "none"]) {
      expect(isHostRole(stageRoleOf(mode))).toBe(mode === null);
    }
  });

  it("keeps the host out of the edit stage and download gate", () => {
    expect(canEditStage("host")).toBe(false);
    for (const role of REVIEW_ROLE_IDS) {
      expect(canEditStage(role)).toBe(roleCan(role, "edit"));
    }
    const base = {
      trackCount: 3,
      jobBusy: false,
      pendingReviewCount: 0,
      lastStage: null,
    };
    expect(landingStage({ ...base, role: "host" })).toBe("edit");
    expect(landingStage({ ...base, role: "host", trackCount: 0 })).toBe(
      "prepare",
    );
    expect(landingStage({ ...base, role: "editor", trackCount: 0 })).toBe(
      "edit",
    );
  });

  it("lists the edit stage for exactly the roles that may edit", () => {
    for (const role of REVIEW_ROLE_IDS) {
      expect(stagesForRole(role).includes("edit")).toBe(roleCan(role, "edit"));
    }
    expect(stagesForRole("host")).toHaveLength(5);
  });
});

describe("shareMode wrappers", () => {
  const wrappers: readonly [
    string,
    (p: string, caps: string[] | null) => boolean,
    Capability | readonly Capability[],
  ][] = [
    ["canApplyPass12", (p, c) => canApplyPass12(p, null, c), "edit"],
    ["canApplyStructural", (p, c) => canApplyStructural(p, null, c), "edit"],
    ["canEditEnvelopes", (p, c) => canEditEnvelopes(p, null, c), "edit"],
    ["canRefreshMix", (p, c) => canRefreshMix(p, null, c), "edit"],
    ["canEditMix", (p, c) => canEditMix(p, null, c), "edit"],
    ["canIngestMedia", (p, c) => canIngestMedia(p, null, c), "edit"],
    ["canComment", (p, c) => canComment(p, null, c), "comment"],
    ["canReply", (p, c) => canReply(p, null, c), "reply"],
    ["canSetAction", (p, c) => canSetAction(p, c), "action"],
    [
      "canSuggestStructural",
      (p, c) => canSuggestStructural(p, null, c),
      ["suggest", "edit"],
    ],
  ];

  for (const [name, wrapper, cap] of wrappers) {
    const caps = Array.isArray(cap) ? cap : [cap as Capability];
    it(`${name} agrees with can() for every role, host and no grants`, () => {
      const asks = (path: string, grants: string[] | null) =>
        caps.some((c) => can(c, { projectPath: path, capabilities: grants }));
      for (const role of REVIEW_ROLE_IDS) {
        const grants = [...REVIEW_ROLE_CAPABILITIES[role]];
        expect(wrapper(SHARE, grants)).toBe(asks(SHARE, grants));
      }
      for (const grants of [null, []] as (string[] | null)[]) {
        expect(wrapper(SHARE, grants)).toBe(false);
        expect(wrapper(HOST, grants)).toBe(true);
      }
    });
  }

  it("keeps the host-only gates off every share key", () => {
    expect(canHostMutate(HOST)).toBe(true);
    expect(canManageProjects(HOST)).toBe(true);
    expect(canHostMutate(SHARE)).toBe(false);
    expect(canManageProjects(SHARE)).toBe(false);
  });
});
