import { describe, expect, it } from "vitest";
import { canIngestMedia, canManageProjects } from "../shareMode";
import { COMMENTER_CAPABILITIES } from "../test/fixtures";

describe("ingest permissions", () => {
  it("allows host ingest and project manage", () => {
    expect(canIngestMedia("/tmp/ep.project.json", null)).toBe(true);
    expect(canManageProjects("/tmp/ep.project.json")).toBe(true);
  });

  it("allows edit guests to ingest but not manage projects", () => {
    expect(canIngestMedia("share:tok", "edit", ["edit"])).toBe(true);
    expect(canManageProjects("share:tok")).toBe(false);
  });

  it("blocks Viewer and Commenter ingest", () => {
    expect(canIngestMedia("share:tok", "view", ["play", "view"])).toBe(false);
    expect(canIngestMedia("share:tok", "comment", COMMENTER_CAPABILITIES)).toBe(
      false,
    );
    expect(canIngestMedia("share:tok", "edit")).toBe(false);
  });
});
