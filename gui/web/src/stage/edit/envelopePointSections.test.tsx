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

const type = async (name: string, text: string) => {
  await press(name, "Enter");
  const input = screen.getByRole("textbox", { name });
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
};

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

  it("refuses a typed time past the timeline end and keeps what was typed", async () => {
    open();
    await type("Time", "11");
    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Time" })).toHaveValue("11");
  });

  it("refuses a typed level above the maximum without clamping it", async () => {
    open();
    await type("Level", "1.6");
    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Level" })).toHaveValue("1.6");
  });

  it("saves a typed time and gives focus back to the field", async () => {
    open();
    await type("Time", "5");
    expect(api.setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [POINTS[0], { id: "b", time: 5, value: 0.5 }],
      POINTS,
    );
    expect(screen.getByRole("spinbutton", { name: "Time" })).toHaveFocus();
  });

  it("holds the fields read-only while a save is in flight and takes no second one", async () => {
    let release: (undo: null) => void = () => {};
    vi.mocked(api.setEnvelope).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    open();
    await press("Level", "ArrowUp");
    expect(screen.getByRole("spinbutton", { name: "Level" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    await press("Level", "ArrowUp");
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
    await act(async () => release(null));
    expect(
      screen.getByRole("spinbutton", { name: "Level" }),
    ).not.toHaveAttribute("aria-readonly");
  });

  it("edits for an editor link", async () => {
    open();
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["edit"],
    });
    await press("Level", "ArrowUp");
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Remove point" })).toBeEnabled();
  });

  it("offers Reload only for a conflict, and edits again after it", async () => {
    vi.mocked(api.setEnvelope).mockRejectedValueOnce(new Error("Disk full"));
    open();
    await press("Level", "ArrowUp");
    expect(screen.getByRole("alert")).toHaveTextContent("Disk full");
    expect(screen.queryByRole("button", { name: "Reload points" })).toBeNull();
    vi.mocked(api.setEnvelope).mockRejectedValueOnce(
      new ApiError("The envelope changed", "conflict", 409),
    );
    await press("Level", "ArrowUp");
    fireEvent.click(screen.getByRole("button", { name: "Reload points" }));
    await press("Level", "ArrowUp");
    expect(api.setEnvelope).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("selects the envelope after a point is removed", async () => {
    open();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove point" }));
    });
    expect(api.setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [POINTS[0]],
      POINTS,
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelope",
      trackId: "host",
    });
  });
});
