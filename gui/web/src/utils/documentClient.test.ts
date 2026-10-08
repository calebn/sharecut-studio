import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextDocumentClientSeq } from "./documentClient";

const key = "daw_document_client_seq";
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("document client counter admission", () => {
  it.each([
    [null, 1],
    ["0", 1],
    ["41", 42],
    ["00041", 42],
    ["9007199254740990", 9007199254740991],
  ] as const)("advances the complete valid counter %s to %s", (raw, next) => {
    if (raw !== null) sessionStorage.setItem(key, raw);
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(nextDocumentClientSeq()).toBe(next);
    expect(write).toHaveBeenCalledExactlyOnceWith(key, String(next));
    expect(sessionStorage.getItem(key)).toBe(String(next));
  });

  it.each([
    "",
    " ",
    "NaN",
    "41tail",
    "1.5",
    "1e2",
    "-1",
    "Infinity",
    "9007199254740992",
    "9007199254740991",
  ])("rejects counter %j before changing its raw value", (raw) => {
    sessionStorage.setItem(key, raw);
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(() => nextDocumentClientSeq()).toThrow();
    expect(sessionStorage.getItem(key)).toBe(raw);
    expect(write).not.toHaveBeenCalled();
  });
});
