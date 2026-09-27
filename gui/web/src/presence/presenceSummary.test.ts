import { describe, expect, it } from "vitest";
import type { SessionClient } from "../types/session";
import { isGuestPresenceClient, presenceSummary } from "./presenceSummary";

const c = (client_id: string, role: string) =>
  ({ client_id, role }) as SessionClient;

describe("presenceSummary", () => {
  it("reads You when only the local client is present (#533)", () => {
    expect(presenceSummary([c("h1", "viewer")], "h1")).toBe("You");
  });

  it("counts share guests", () => {
    expect(
      presenceSummary(
        [
          c("h1", "viewer"),
          c("guest-abcd1234-x1", "viewer"),
          c("guest-abcd1234-x2", "viewer"),
        ],
        "h1",
      ),
    ).toBe("You + 2 guests");
  });

  it("treats a guest's own client as local and others as hosts", () => {
    expect(
      presenceSummary(
        [c("guest-abcd1234-x1", "viewer"), c("h1", "viewer")],
        "x1",
      ),
    ).toBe("You + 1 host");
  });

  it("lists agents and cli separately", () => {
    expect(
      presenceSummary(
        [c("h1", "viewer"), c("g", "guest"), c("a1", "agent"), c("c1", "cli")],
        "h1",
      ),
    ).toBe("You + 1 guest · 2 agents");
  });

  it("identifies guests", () => {
    expect(isGuestPresenceClient(c("guest-a-b", "viewer"))).toBe(true);
    expect(isGuestPresenceClient(c("x", "guest"))).toBe(true);
    expect(isGuestPresenceClient(c("h1", "viewer"))).toBe(false);
  });
});
