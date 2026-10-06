import { afterEach, describe, expect, it } from "vitest";
import {
  applyLabQuery,
  isLabEnabled,
  LAB_STORAGE_KEY,
  setLabEnabled,
} from "./labFlags";

afterEach(() => {
  setLabEnabled("touchChooser", false);
});

describe("lab flags", () => {
  it("are off by default", () => {
    expect(isLabEnabled("touchChooser")).toBe(false);
  });

  it("turn on and off from ?lab= and persist the choice", () => {
    applyLabQuery("?project=/ep&lab=touch-chooser");
    expect(isLabEnabled("touchChooser")).toBe(true);
    expect(localStorage.getItem(LAB_STORAGE_KEY)).toBe("touchChooser");

    applyLabQuery("?lab=-touch-chooser");
    expect(isLabEnabled("touchChooser")).toBe(false);
    expect(localStorage.getItem(LAB_STORAGE_KEY)).toBe("");
  });

  it("ignore unknown slugs", () => {
    applyLabQuery("?lab=warp-drive");
    expect(isLabEnabled("touchChooser")).toBe(false);
  });
});
