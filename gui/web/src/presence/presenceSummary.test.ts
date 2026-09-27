import { describe, expect, it } from "vitest";
import type { SessionClient } from "../types/session";
import {
  isGuestPresenceClient,
  presenceSummary,
  selectAgentPresent,
} from "./presenceSummary";

const c = (client_id: string, role: string) =>
  ({ client_id, role }) as SessionClient;

describe("presenceSummary", () => {
  it("counts an agent with a guest- id as an agent", () => {
    expect(presenceSummary([c("guest-x-y", "agent")], null)).toBe(
      "You · 1 agent",
    );
  });

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

  it("treats no row as local before the local id is known", () => {
    expect(presenceSummary([c("h1", "viewer")], null)).toBe("You + 1 host");
    expect(
      presenceSummary(
        [c("h1", "viewer"), c("guest-abcd1234-x1", "viewer")],
        null,
      ),
    ).toBe("You + 1 host + 1 guest");
  });

  it("selectAgentPresent is true only while an agent is in the roster", () => {
    expect(selectAgentPresent({ sessionClients: [] })).toBe(false);
    expect(selectAgentPresent({ sessionClients: [c("h1", "viewer")] })).toBe(
      false,
    );
    expect(
      selectAgentPresent({
        sessionClients: [c("h1", "viewer"), c("a1", "agent")],
      }),
    ).toBe(true);
  });
});
