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

  it("reads the saving percent in the pill, held to 0 to 100", () => {
    const at = (percent: number) =>
      roomPillRendering({
        kind: "saving",
        savedPeople: 0,
        totalPeople: 2,
        percent,
      });
    expect(at(64.4)).toMatchObject({ text: "Saving · 64%", progress: 0.64 });
    expect(at(140)).toMatchObject({ text: "Saving · 100%", progress: 1 });
    expect(at(-3)).toMatchObject({ text: "Saving · 0%", progress: 0 });
    expect(at(Number.NaN).text).toBe("Saving · 0 of 2");
  });

  it("reads a stopped upload as failed, not as progress", () => {
    expect(
      roomPillRendering({
        kind: "saving",
        savedPeople: 0,
        totalPeople: 1,
        percent: 40,
        failed: true,
      }),
    ).toEqual({ state: "failed", text: "Saving stopped" });
  });

  it("writes an hour as h:mm:ss", () => {
    expect(clockText(3723)).toBe("1:02:03");
    expect(clockText(-5)).toBe("0:00");
  });
});
