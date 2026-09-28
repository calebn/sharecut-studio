import { describe, expect, it } from "vitest";
import { transportMenuTitle } from "./transportMenuTitle";

describe("transportMenuTitle", () => {
  it.each([
    [true, true, "Project, media, markers, and help"],
    [false, true, "Media and help"],
    [false, false, "Help"],
    [true, false, "Project, markers, and help"],
  ])("mayManage=%s mayIngest=%s → %s", (mayManage, mayIngest, title) => {
    expect(transportMenuTitle({ mayManage, mayIngest })).toBe(title);
  });
});
