import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRecordName, writeRecordName } from "./recordNamePref";

describe("recordNamePref", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("reads back the trimmed, capped name it wrote", () => {
    writeRecordName("  Ava   Okafor ");
    expect(localStorage.getItem("sharecut.recordName")).toBe("Ava Okafor");
    expect(readRecordName()).toBe("Ava Okafor");
  });

  it("does not write a blank name", () => {
    writeRecordName("   ");
    expect(localStorage.getItem("sharecut.recordName")).toBeNull();
  });

  it("reads an empty name when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRecordName()).toBe("");
  });
});
