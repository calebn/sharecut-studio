import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DawProvider } from "../state/store";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { TrackPlaysAt } from "./TrackPlaysAt";

function setup(value: number | null) {
  const project = minimalProject({
    tracks: [sampleTrack({ id: "mira" })],
    envelopes:
      value === null
        ? []
        : [
            {
              track_id: "mira",
              parameter: "volume",
              points: [{ id: "a", time: 0, value }],
            },
          ],
  });
  return render(
    <DawProvider projectPath="/tmp/p.json" initialProject={project}>
      <TrackPlaysAt trackId="mira" baseDb={-3} />
    </DawProvider>,
  );
}

describe("TrackPlaysAt", () => {
  it("adds the envelope at the playhead to the base gain", () => {
    setup(0.5);
    expect(screen.getByText(/^Plays at/)).toHaveTextContent("Plays at −9.0 dB");
  });

  it("reads −∞ when the envelope is silent", () => {
    setup(0);
    expect(screen.getByText(/^Plays at/)).toHaveTextContent("Plays at −∞ dB");
  });

  it("renders nothing without a volume envelope", () => {
    setup(null);
    expect(screen.queryByText(/^Plays at/)).toBeNull();
  });
});
