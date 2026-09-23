import { act, render, screen } from "@testing-library/react";
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
          { id: "early", time: 0, value: 1 },
          { id: "late", time: 5, value: 0.5 },
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
      { id: "early", time: 0, value: 1 },
      { id: "late", time: 5, value: 0.25 },
    ]);
    await expectNoA11yViolations(container);
  });

  it("deletes a point and clears selection", async () => {
    render(<EnvelopePointInspector trackId="host" index={1} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(setEnvelope).toHaveBeenCalledWith("/tmp/p.json", "host", [
      { id: "early", time: 0, value: 1 },
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
      { id: "early", time: 0, value: 1 },
      { id: "late", time: 5, value: 1.5 },
    ]);
  });

  it("commits time on form Enter", async () => {
    render(<EnvelopePointInspector trackId="host" index={1} />);
    const time = screen.getByLabelText("Envelope time");
    await userEvent.clear(time);
    await userEvent.type(time, "2");
    await userEvent.keyboard("{Enter}");
    expect(setEnvelope).toHaveBeenCalledWith("/tmp/p.json", "host", [
      { id: "early", time: 0, value: 1 },
      { id: "late", time: 2, value: 0.5 },
    ]);
  });

  it.each([
    ["Apply", "button", "Apply"],
    ["Delete", "button", "Delete"],
  ])(
    "does not %s a point replaced at the same time",
    async (_action, role, name) => {
      render(<EnvelopePointInspector trackId="host" index={1} />);

      const latestProject = useDawStore.getState().project;
      if (!latestProject) {
        throw new Error("Expected project to be hydrated");
      }
      latestProject.envelopes[0].points[1] = {
        id: "peer-replacement",
        time: 5,
        value: 0.25,
      };

      await userEvent.click(screen.getByRole(role, { name }));

      expect(setEnvelope).not.toHaveBeenCalled();
      expect(
        screen.getByText("Envelope point changed; select it again"),
      ).toBeTruthy();
    },
  );

  it("clears a stale-point error after selecting the point again", async () => {
    render(<EnvelopePointInspector trackId="host" index={1} />);
    const project = useDawStore.getState().project;
    if (!project) {
      throw new Error("Expected project to be hydrated");
    }
    project.envelopes[0].points[1] = {
      id: "peer-replacement",
      time: 5,
      value: 0.25,
    };
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      screen.getByText("Envelope point changed; select it again"),
    ).toBeTruthy();

    act(() => {
      useDawStore.getState().setSelection({
        kind: "envelopePoint",
        trackId: "host",
        index: 1,
      });
    });
    expect(
      screen.queryByText("Envelope point changed; select it again"),
    ).toBeNull();
  });
});
