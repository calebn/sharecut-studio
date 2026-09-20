import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { TrackView } from "../../types/project";
import { EnvelopePointInspector } from "./EnvelopePointInspector";

const setEnvelope = vi.fn();

vi.mock("../../api", () => ({
  setEnvelope: (...args: unknown[]) => setEnvelope(...args),
}));

function hostTrack(): TrackView {
  return {
    id: "host",
    label: "Host",
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 10,
    fx_count: 0,
    stem_is_fresh: true,
  };
}

function projectWithEnvelope() {
  return minimalProject({
    tracks: [hostTrack()],
    envelopes: [
      {
        track_id: "host",
        parameter: "volume",
        points: [
          { time: 0, value: 1 },
          { time: 5, value: 0.5 },
        ],
      },
    ],
  });
}

describe("EnvelopePointInspector", () => {
  beforeEach(() => {
    setEnvelope.mockReset();
    setEnvelope.mockResolvedValue({});
    useDawStore.getState().hydrate("/tmp/p.json", projectWithEnvelope());
    useDawStore.getState().setSelection({
      kind: "envelopePoint",
      trackId: "host",
      index: 1,
    });
  });

  it("applies time and value via SetEnvelope", async () => {
    const { container } = render(
      <EnvelopePointInspector trackId="host" index={1} />,
    );
    expect(screen.getByText("Envelope")).toBeTruthy();
    const value = screen.getByLabelText("Envelope value");
    await userEvent.clear(value);
    await userEvent.type(value, "0.25");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(setEnvelope).toHaveBeenCalledWith("/tmp/p.json", "host", [
      { time: 0, value: 1 },
      { time: 5, value: 0.25 },
    ]);
    await expectNoA11yViolations(container);
  });

  it("deletes a point and clears selection", async () => {
    render(<EnvelopePointInspector trackId="host" index={1} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(setEnvelope).toHaveBeenCalledWith("/tmp/p.json", "host", [
      { time: 0, value: 1 },
    ]);
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("clamps value to the overlay range", async () => {
    render(<EnvelopePointInspector trackId="host" index={1} />);
    const value = screen.getByLabelText("Envelope value");
    await userEvent.clear(value);
    await userEvent.type(value, "9");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(setEnvelope).toHaveBeenCalledWith("/tmp/p.json", "host", [
      { time: 0, value: 1 },
      { time: 5, value: 1.5 },
    ]);
  });

  it("commits time on form Enter", async () => {
    render(<EnvelopePointInspector trackId="host" index={1} />);
    const time = screen.getByLabelText("Envelope time");
    await userEvent.clear(time);
    await userEvent.type(time, "2");
    await userEvent.keyboard("{Enter}");
    expect(setEnvelope).toHaveBeenCalledWith("/tmp/p.json", "host", [
      { time: 0, value: 1 },
      { time: 2, value: 0.5 },
    ]);
  });
});
