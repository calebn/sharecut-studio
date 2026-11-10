import { beforeEach, describe, expect, it } from "vitest";
import { readSnapPref, writeSnapPref } from "./snapPref";

describe("snap preference", () => {
  beforeEach(() => localStorage.clear());

  it("is on until the person turns it off", () => {
    expect(readSnapPref()).toBe(true);
    localStorage.setItem("sharecut.snap", "garbage");
    expect(readSnapPref()).toBe(true);
  });

  it("round-trips through localStorage", () => {
    writeSnapPref(false);
    expect(readSnapPref()).toBe(false);
    writeSnapPref(true);
    expect(readSnapPref()).toBe(true);
  });
});
