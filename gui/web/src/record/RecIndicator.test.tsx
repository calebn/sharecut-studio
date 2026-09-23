import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { recordSnapshot } from "../test/fixtures";
import { recordingClockMs } from "./clock";
import { RecIndicator } from "./RecIndicator";

const base = recordSnapshot({
  session_id: "room1",
  state: "lobby",
  take_index: -1,
  recording_ms: 0,
});

describe("RecIndicator", () => {
  it("computes paused clock without adding wall time", () => {
    expect(
      recordingClockMs(
        { ...base, state: "paused", recording_ms: 70_000 },
        5_000,
      ),
    ).toBe(70_000);
    expect(
      recordingClockMs(
        { ...base, state: "recording", recording_ms: 70_000 },
        5_000,
      ),
    ).toBe(75_000);
  });

  it("labels REC, PAUSED, and Stopped", () => {
    const { rerender } = render(
      <RecIndicator snapshot={{ ...base, state: "recording" }} />,
    );
    expect(screen.getByText("REC")).toBeInTheDocument();
    expect(document.querySelector(".record-rec-dot")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    rerender(<RecIndicator snapshot={{ ...base, state: "paused" }} />);
    expect(screen.getByText("PAUSED")).toBeInTheDocument();
    expect(document.querySelector(".record-rec-dot")).toBeNull();
    rerender(<RecIndicator snapshot={{ ...base, state: "stopped" }} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("does not show a healthy REC label after local capture fails", () => {
    render(
      <RecIndicator snapshot={{ ...base, state: "recording" }} captureFailed />,
    );
    expect(screen.getByText("REC: local capture failed")).toBeInTheDocument();
    expect(screen.queryByText("REC")).not.toBeInTheDocument();
    expect(document.querySelector(".record-rec-dot")).toBeNull();
  });

  it("distinguishes a pending microphone from healthy capture", () => {
    render(
      <RecIndicator
        snapshot={{ ...base, state: "recording" }}
        capturePending
      />,
    );
    expect(
      screen.getByText("REC — waiting for microphone"),
    ).toBeInTheDocument();
    expect(screen.queryByText("REC")).not.toBeInTheDocument();
  });
});
