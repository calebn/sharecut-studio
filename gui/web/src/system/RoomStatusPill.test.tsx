import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoomStatusPill } from "./RoomStatusPill";
import { clockText, roomPillRendering } from "./roomPhase";

describe("RoomStatusPill", () => {
  it.each([
    [{ kind: "waiting", host: "Maya" } as const, "Waiting for Maya to start"],
    [{ kind: "waiting" } as const, "Waiting"],
    [{ kind: "countdown", secondsLeft: 3 } as const, "Quiet please · 3"],
    [{ kind: "live", take: 2, clockSec: 724 } as const, "12:04 · Take 2"],
    [{ kind: "paused", clockSec: 724 } as const, "Paused · 12:04"],
    [
      { kind: "saving", savedPeople: 2, totalPeople: 3 } as const,
      "Saving · 2 of 3",
    ],
    [{ kind: "saved" } as const, "Saved"],
    [{ kind: "reconnecting" } as const, "Reconnecting…"],
  ])("says %j in words", (phase, text) => {
    render(<RoomStatusPill phase={phase} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("uses the live glyph only while a take runs", () => {
    expect(
      roomPillRendering({ kind: "live", take: 1, clockSec: 0 }).state,
    ).toBe("live");
    expect(roomPillRendering({ kind: "paused", clockSec: 0 }).state).not.toBe(
      "live",
    );
  });

  it("fills the saving ring by the people saved", () => {
    expect(
      roomPillRendering({ kind: "saving", savedPeople: 1, totalPeople: 4 })
        .progress,
    ).toBe(0.25);
  });

  it("writes an hour as h:mm:ss", () => {
    expect(clockText(3723)).toBe("1:02:03");
    expect(clockText(-5)).toBe("0:00");
  });
});
