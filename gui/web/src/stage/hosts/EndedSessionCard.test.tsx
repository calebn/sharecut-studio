import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RecordSessionSummary } from "../../record";
import { expectNoA11yViolations } from "../../test/a11y";
import { EndedSessionCard } from "./EndedSessionCard";

const base: RecordSessionSummary = {
  session_id: "s1",
  number: 2,
  state: "ended",
  target_kind: null,
  takes: [
    { take_index: 0, recording_ms: 360_000 },
    { take_index: 1, recording_ms: 300_000 },
    { take_index: 2, recording_ms: 64_000 },
  ],
  participants: [
    { participant_id: "a", display_name: "Ava", role: "guest", track_id: "t1" },
    { participant_id: "b", display_name: "Sam", role: "guest", track_id: null },
  ],
  landed: true,
  ended_at: "2026-10-25T18:00:00Z",
};
const names = new Map([["t1", "Ava"]]);

const mount = (over: Partial<RecordSessionSummary> = {}) =>
  render(
    <EndedSessionCard session={{ ...base, ...over }} trackNames={names} />,
  );

describe("EndedSessionCard", () => {
  it("shows the numbered heading with the date, the take line and mapping rows", async () => {
    const { container } = mount();
    const region = screen.getByRole("region", {
      name: "Session 2 · Sun 25 Oct",
    });
    expect(within(region).getByText("3 takes · 12:04")).toBeInTheDocument();
    const rows = within(region).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Ava → Ava",
      "Sam → New track",
    ]);
    await expectNoA11yViolations(container);
  });

  it("falls back to Last session and omits a missing date", () => {
    mount({ number: null, ended_at: null });
    expect(
      screen.getByRole("heading", { name: "Last session" }),
    ).toBeInTheDocument();
  });

  it("names only the participant when the session never landed", () => {
    mount({ landed: false, number: null });
    expect(screen.getAllByRole("listitem").map((r) => r.textContent)).toEqual([
      "Ava",
      "Sam",
    ]);
  });

  it("says No takes and formats hours", () => {
    const { rerender } = mount({ takes: [] });
    expect(screen.getByText("No takes")).toBeInTheDocument();
    rerender(
      <EndedSessionCard
        session={{
          ...base,
          takes: [{ take_index: 0, recording_ms: 3_725_000 }],
        }}
        trackNames={names}
      />,
    );
    expect(screen.getByText("1 take · 1:02:05")).toBeInTheDocument();
  });
});
