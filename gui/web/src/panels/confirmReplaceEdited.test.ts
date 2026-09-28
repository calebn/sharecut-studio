import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmReplaceEdited } from "./confirmReplaceEdited";

describe("confirmReplaceEdited", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false without prompting when nothing is edited", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    expect(confirmReplaceEdited([], "Re-transcribe")).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("returns true and names the track when accepted (singular)", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(confirmReplaceEdited(["host"], "Re-time words")).toBe(true);
    expect(window.confirm).toHaveBeenCalledWith(
      "1 track has hand-edited transcripts that Re-time words will replace: host. Replace them?",
    );
  });

  it("uses the plural phrasing and lists every track", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(confirmReplaceEdited(["host", "guest"], "Re-transcribe")).toBe(true);
    expect(window.confirm).toHaveBeenCalledWith(
      "2 tracks have hand-edited transcripts that Re-transcribe will replace: host, guest. Replace them?",
    );
  });

  it("returns null when declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(confirmReplaceEdited(["host"], "Re-transcribe")).toBeNull();
  });
});
