import { describe, expect, it } from "vitest";
import { ApiError } from "../utils/apiError";
import {
  KIT_SAVE_FAILED,
  kitSavedMessage,
  kitSaveMessage,
} from "./kitSaveMessages";

const refused = (code: string | null, message = "The studio says no.") =>
  new ApiError(message, code, 409);

describe("kitSaveMessage", () => {
  it.each([
    ["kit_name_invalid", /letter or digit/],
    ["kit_segment_missing", /Remove it from the list, then save again/],
    ["kit_busy", /Another action is using the kit library/],
    ["kit_write_failed", /room on the disk/],
    ["kit_no_room", /no room left/],
  ])("%s", (code, text) => {
    expect(kitSaveMessage(refused(code))).toMatch(text);
  });

  it("passes the studio's own words for kit_invalid and for a code it does not know", () => {
    expect(
      kitSaveMessage(refused("kit_invalid", "A kit holds up to 32.")),
    ).toBe("A kit holds up to 32.");
    expect(kitSaveMessage(refused("other_code", "Odd."))).toBe("Odd.");
  });

  it("falls back for something that is not an Error", () => {
    expect(kitSaveMessage("boom")).toBe(KIT_SAVE_FAILED);
    expect(KIT_SAVE_FAILED).not.toMatch(/not found/i);
  });

  it("never says not found", () => {
    for (const code of [
      "kit_name_invalid",
      "kit_segment_missing",
      "kit_busy",
      "kit_write_failed",
      "kit_no_room",
    ]) {
      expect(kitSaveMessage(refused(code))).not.toMatch(/not found/i);
    }
  });
});

describe("kitSavedMessage", () => {
  it("says what each outcome did", () => {
    expect(
      kitSavedMessage("Show", { status: "added", id: "s", version: 1 }, 3),
    ).toBe("Saved the kit Show with 3 segments.");
    expect(
      kitSavedMessage("Show", { status: "added", id: "s", version: 1 }, 1),
    ).toBe("Saved the kit Show with 1 segment.");
    expect(
      kitSavedMessage(
        "Show",
        { status: "new_version", id: "s", version: 3 },
        2,
      ),
    ).toBe("Saved a new version of Show (v3). The earlier version is kept.");
    expect(
      kitSavedMessage("Show", { status: "unchanged", id: "s", version: 2 }, 2),
    ).toBe("Show already has these segments. Nothing changed.");
  });
});
