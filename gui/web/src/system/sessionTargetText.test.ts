import { describe, expect, it } from "vitest";
import {
  sessionTargetMenuText,
  sessionTargetPlacement,
  sessionTargetText,
} from "./sessionTargetText";

describe("sessionTargetText", () => {
  it("words each target", () => {
    expect(sessionTargetText({ kind: "end", afterSec: 3130 })).toBe(
      "Lands at the end · after 52:10",
    );
    // A loaded project with no clip to land after: the session starts the episode.
    expect(sessionTargetText({ kind: "end", empty: true })).toBe(
      "Starts the episode",
    );
    // Not loaded yet: say nothing about the project.
    expect(sessionTargetText({ kind: "end" })).toBe("Lands at the end");
    expect(sessionTargetText({ kind: "start" })).toBe("Starts the episode");
    expect(sessionTargetText({ kind: "insert", atSec: 724 })).toBe(
      "Inserts at 12:04",
    );
    expect(
      sessionTargetText({ kind: "replace", fromSec: 724, toSec: 749 }),
    ).toBe("Replaces 12:04-12:29");
  });

  it("places an end in an empty project at the start", () => {
    expect(sessionTargetPlacement({ kind: "end", empty: true })).toBe("start");
    expect(sessionTargetPlacement({ kind: "end" })).toBe("end");
    expect(sessionTargetPlacement({ kind: "end", afterSec: 0 })).toBe("end");
    expect(sessionTargetPlacement({ kind: "insert", atSec: 1 })).toBe("insert");
  });

  it("uses hours past an hour", () => {
    expect(sessionTargetText({ kind: "insert", atSec: 3725 })).toBe(
      "Inserts at 1:02:05",
    );
  });

  it("words the menu entries", () => {
    expect(sessionTargetMenuText("end")).toBe("At the end");
    expect(sessionTargetMenuText("start")).toBe("At the start");
    expect(sessionTargetMenuText("insert", 724)).toBe(
      "At the playhead (12:04)",
    );
    expect(sessionTargetMenuText("insert")).toBe("At the playhead");
    expect(sessionTargetMenuText("replace")).toBe("Replace selection");
  });
});
