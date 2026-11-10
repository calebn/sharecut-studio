import { beforeEach, describe, expect, it } from "vitest";
import {
  parseSnapPref,
  readSnapPref,
  SNAP_STORAGE_KEY,
  writeSnapPref,
} from "./snapPref";

describe("snap preference", () => {
  beforeEach(() => localStorage.clear());

  it("is on until the person turns it off", () => {
    expect(parseSnapPref(null)).toBe(true);
    expect(parseSnapPref("garbage")).toBe(true);
    expect(parseSnapPref("off")).toBe(false);
  });

  it("round-trips through localStorage", () => {
    writeSnapPref(false);
    expect(localStorage.getItem(SNAP_STORAGE_KEY)).toBe("off");
    expect(readSnapPref()).toBe(false);
    writeSnapPref(true);
    expect(readSnapPref()).toBe(true);
  });
});
