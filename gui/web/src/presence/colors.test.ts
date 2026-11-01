import { describe, expect, it } from "vitest";
import {
  disambiguatedNames,
  initials,
  presenceColorVar,
  rosterDisplayName,
} from "./colors";

describe("presence colors", () => {
  it("maps index onto CSS vars", () => {
    expect(presenceColorVar(3)).toBe("var(--color-presence-3)");
    expect(presenceColorVar(-1)).toBe("var(--color-presence-7)");
    expect(presenceColorVar(undefined)).toBe("var(--color-presence-0)");
  });

  it("builds initials", () => {
    expect(initials("Caleb Nelson")).toBe("CN");
    expect(initials("  ")).toBe("?");
    expect(initials("Agent")).toBe("A");
    expect(initials("Host ·2")).toBe("H");
    expect(initials("·2")).toBe("?");
  });

  it("takes whole characters, so an astral letter is not split in two", () => {
    expect(initials("𠮷野 家")).toBe("𠮷家");
    expect(initials("𝒜da")).toBe("𝒜");
  });

  it("disambiguates duplicate names", () => {
    const names = disambiguatedNames([
      { client_id: "a", meta: { display_name: "Ada" } },
      { client_id: "b", label: "Ada" },
      { client_id: "c", label: "Bo" },
    ]);
    expect(names.get("a")).toBe("Ada");
    expect(names.get("b")).toBe("Ada ·2");
    expect(names.get("c")).toBe("Bo");
    expect(rosterDisplayName({ client_id: "x" })).toBe("x");
  });
});
