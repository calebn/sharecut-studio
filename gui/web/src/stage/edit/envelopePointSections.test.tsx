import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { ApiError } from "../../utils/apiError";
import { EnvelopePointBody } from "./EnvelopePointBody";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  setEnvelope: vi.fn(async () => null),
}));

const POINTS = [
  { id: "a", time: 1, value: 1 },
  { id: "b", time: 1.01, value: 0.5 },
];

function open(points = POINTS, pointId = "b") {
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      timeline_duration_sec: 10,
      envelopes: [
        {
          track_id: "host",
          parameter: "volume",
          points: structuredClone(points),
        },
      ],
    }),
  );
  useDawStore.getState().setLayerVisible("showLevels", true);
  useDawStore.setState({
    selection: { kind: "envelopePoint", trackId: "host", pointId },
  });
  return render(<EnvelopePointBody />);
}

const press = (name: string, key: string) =>
  act(async () => {
    fireEvent.keyDown(screen.getByRole("spinbutton", { name }), { key });
  });

describe("envelope point content", () => {
  beforeEach(() => {
    vi.mocked(api.setEnvelope).mockReset().mockResolvedValue(null);
  });

  it("shows the point's Time and Level and saves one Level step as one write", async () => {
    open();
    expect(screen.getByRole("spinbutton", { name: "Time" })).toHaveAttribute(
      "aria-valuenow",
      "1.01",
    );
    expect(screen.getByRole("spinbutton", { name: "Level" })).toHaveAttribute(
      "aria-valuetext",
      "0.50 ×",
    );
    await press("Level", "ArrowUp");
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
    expect(api.setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [POINTS[0], { id: "b", time: 1.01, value: 0.51 }],
      POINTS,
    );
  });

  it("alerts when the time is taken and selects the point that holds it", async () => {
    open();
    await press("Time", "ArrowDown");
    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A point already exists at this time",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select the point there" }),
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      pointId: "a",
    });
  });

  it("keeps a conflict visible with a reload until it is taken", async () => {
    vi.mocked(api.setEnvelope).mockRejectedValueOnce(
      new ApiError("The envelope changed", "conflict", 409),
    );
    open();
    await press("Level", "ArrowUp");
    expect(screen.getByRole("alert")).toHaveTextContent("The envelope changed");
    fireEvent.click(screen.getByRole("button", { name: "Reload points" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes the point, and the last one removes the envelope", async () => {
    open([POINTS[1]!]);
    expect(screen.getByText(/returns automation to 1.00×/)).toBeVisible();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Remove volume envelope" }),
      );
    });
    expect(api.setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [],
      [POINTS[1]],
    );
  });

  it("is read-only for a view-only link, with no Remove", async () => {
    open();
    useDawStore.setState({ projectPath: "share:tok", shareCapabilities: [] });
    await act(async () => {});
    expect(screen.getByRole("spinbutton", { name: "Level" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(screen.getByText(/can view, but not edit/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("asks for the envelope to be shown before points change", async () => {
    open();
    act(() => useDawStore.getState().setLayerVisible("showLevels", false));
    expect(screen.getByRole("status")).toHaveTextContent("hidden");
    expect(screen.getByRole("spinbutton", { name: "Time" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(screen.getByRole("button", { name: "Remove point" })).toBeDisabled();
  });

  it("says so when the point has gone", () => {
    open(POINTS, "zzz");
    expect(screen.getByText(/no longer available/)).toBeVisible();
  });
});
