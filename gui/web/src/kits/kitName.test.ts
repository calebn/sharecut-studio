import { describe, expect, it } from "vitest";
import { HEALTHY, MULTI_VERSION } from "./fixtures";
import {
  KIT_NAME_MAX,
  KIT_NAME_NO_LETTER,
  KIT_NAME_REQUIRED,
  KIT_NAME_TOO_LONG,
  kitNameProblem,
  matchKitName,
  nameHint,
} from "./kitName";

describe("kitNameProblem", () => {
  // The same cases the server's kit_id_for answers (tests/test_kit_save_route.py).
  it.each([
    ["", KIT_NAME_REQUIRED],
    ["   ", KIT_NAME_REQUIRED],
    ["日本", KIT_NAME_NO_LETTER],
    ["!!! ???", KIT_NAME_NO_LETTER],
    ["x".repeat(KIT_NAME_MAX + 1), KIT_NAME_TOO_LONG],
    [`${"x".repeat(KIT_NAME_MAX)}  `, null],
    ["Show", null],
    ["  Show Kit  ", null],
    ["7", null],
    ["Café", null],
    ["ｓｈｏｗ", null],
    ["日本 show", null],
  ])("%j -> %j", (name, problem) => {
    expect(kitNameProblem(name)).toBe(problem);
  });

  it("counts characters the way the server does, not UTF-16 units", () => {
    expect(kitNameProblem(`a${"😀".repeat(KIT_NAME_MAX - 1)}`)).toBeNull();
    expect(kitNameProblem(`a${"😀".repeat(KIT_NAME_MAX)}`)).toBe(
      KIT_NAME_TOO_LONG,
    );
  });
});

describe("matchKitName", () => {
  const rows = [HEALTHY, MULTI_VERSION];

  it("is a new kit when no name matches, or the library is not loaded", () => {
    expect(matchKitName("Other", rows)).toEqual({ kind: "new" });
    expect(matchKitName("Show Kit", null)).toEqual({ kind: "new" });
  });

  it("is the next version for the same trimmed name", () => {
    expect(matchKitName("  Summer series ", rows)).toEqual({
      kind: "version",
      name: "Summer series",
    });
  });

  it("warns that a name differing only in case makes a separate kit", () => {
    const match = matchKitName("show kit", rows);
    expect(match).toEqual({ kind: "lookalike", name: "Show Kit" });
    expect(nameHint(match)).toBe(
      "A kit called Show Kit exists. This saves a separate kit.",
    );
  });

  it("says what each match does", () => {
    expect(nameHint({ kind: "new" })).toBe("Saves a new kit.");
    expect(nameHint({ kind: "version", name: "Show Kit" })).toBe(
      "Saves to the existing kit Show Kit if anything changed. The earlier version is kept.",
    );
  });
});
