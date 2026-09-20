import { describe, expect, it } from "vitest";
import {
  disambiguatedNames,
  initials,
  presenceColorVar,
  rosterDisplayName,
} from "./colors";

describe("presence colors", () => {
  it("maps index onto CSS vars", () => {
    expect(presenceColorVar(3)).toBe("var(--presence-3)");
    expect(presenceColorVar(-1)).toBe("var(--presence-7)");
    expect(presenceColorVar(undefined)).toBe("var(--presence-0)");
  });

  it("builds initials", () => {
    expect(initials("Caleb Nelson")).toBe("CN");
    expect(initials("  ")).toBe("?");
    expect(initials("Agent")).toBe("A");
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
