import { expect, it } from "vitest";
import { KIND_META } from "./decisionKinds";

it("states wave for every kind", () => {
  for (const meta of Object.values(KIND_META)) {
    expect(typeof meta.wave).toBe("boolean");
  }
});
