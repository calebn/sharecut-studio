import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { AutomationPoint, TrackView } from "../../types/project";
import { EnvelopeWorkspace } from "./EnvelopeWorkspace";

const setEnvelope = vi.fn();
vi.mock("../../api", () => ({
  setEnvelope: (...args: unknown[]) => setEnvelope(...args),
}));
const track: TrackView = {
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
const initial = [
  { id: "late", time: 5, value: 0.5 },
  { id: "early", time: 0, value: 1 },
];
function hydrate(
  points: AutomationPoint[] = initial,
  pointId: string | null = "late",
) {
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [track],
      timeline_duration_sec: 10,
      envelopes: [{ track_id: "host", parameter: "volume", points }],
    }),
  );
  useDawStore
    .getState()
    .setSelection(
      pointId
        ? { kind: "envelopePoint", trackId: "host", pointId }
        : { kind: "envelope", trackId: "host" },
    );
}
function mount(pointId: string | null = "late") {
  return render(<EnvelopeWorkspace trackId="host" pointId={pointId} />);
}
async function edit() {
  await userEvent.click(screen.getByRole("button", { name: "Edit point" }));
}
async function level(value: string) {
  const input = screen.getByLabelText("Level (×)");
  await userEvent.clear(input);
  await userEvent.type(input, value);
}
async function time(value: string) {
  const input = screen.getByLabelText("Time (seconds on timeline)");
  await userEvent.clear(input);
  await userEvent.type(input, value);
}
async function save() {
  await userEvent.click(screen.getByRole("button", { name: "Save point" }));
}

describe("EnvelopeWorkspace", () => {
  beforeEach(() => {
    setEnvelope.mockReset();
    setEnvelope.mockResolvedValue(undefined);
    hydrate();
  });
  it("opens an empty workspace without saving; first draft defaults to zero/unity and cancels", async () => {
    hydrate([], null);
    const { container } = mount(null);
    expect(setEnvelope).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    expect(screen.getByLabelText("Time (seconds on timeline)")).toHaveValue(0);
    expect(screen.getByLabelText("Level (×)")).toHaveValue(1);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Save point" })).toBeNull();
    expect(setEnvelope).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });
  it("adds a stable first point only on explicit submit, never blur", async () => {
    hydrate([], null);
    mount(null);
    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    await userEvent.tab();
    expect(setEnvelope).not.toHaveBeenCalled();
    await save();
    const next = setEnvelope.mock.calls[0]![2] as AutomationPoint[];
    expect(next).toEqual([{ id: expect.any(String), time: 0, value: 1 }]);
    expect(setEnvelope).toHaveBeenCalledWith("/tmp/p.json", "host", next, []);
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      pointId: next[0]!.id,
    });
  });
  it("sends the raw unsorted origin and edits the exact ID", async () => {
    mount();
    await edit();
    await level("0.25");
    await save();
    expect(setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [
        { id: "early", time: 0, value: 1 },
        { id: "late", time: 5, value: 0.25 },
      ],
      initial,
    );
  });
  it("does not create history merely to sort an unchanged envelope", async () => {
    mount();
    await edit();
    await save();
    expect(setEnvelope).not.toHaveBeenCalled();
  });
  it("rejects an invalid level rather than clamping it", async () => {
    mount();
    await edit();
    await level("9");
    await save();
    expect(
      screen.getByText("Level must be a number from 0 to 1.50."),
    ).toBeTruthy();
    expect(setEnvelope).not.toHaveBeenCalled();
  });
  it("rejects a newly coincident time and offers the exact existing point", async () => {
    mount();
    await edit();
    await time("0");
    await save();
    expect(setEnvelope).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Discard draft and select existing point",
      }),
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      pointId: "early",
    });
  });
  it("retains both existing coincident IDs when editing a value", async () => {
    const tied = [
      { id: "early", time: 5, value: 1 },
      { id: "late", time: 5, value: 0.5 },
    ];
    hydrate(tied);
    mount();
    await edit();
    await level("0.2");
    await save();
    expect(setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [{ ...tied[0]! }, { ...tied[1]!, value: 0.2 }],
      tied,
    );
  });
  it("rejects a stale whole-envelope baseline and preserves draft text", async () => {
    mount();
    await edit();
    await level("0.25");
    act(() => {
      const project = useDawStore.getState().project!;
      useDawStore.setState({
        project: {
          ...project,
          envelopes: [
            {
              track_id: "host",
              parameter: "volume",
              points: [...initial, { id: "peer", time: 8, value: 1 }],
            },
          ],
        },
      });
    });
    await save();
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Level (×)")).toHaveValue(0.25);
    expect(screen.getByText(/This envelope changed/)).toBeTruthy();
  });
  it("retains a rejected draft and point ID for deliberate retry", async () => {
    hydrate([], null);
    setEnvelope.mockRejectedValueOnce(
      new Error("Conflict: reload the envelope"),
    );
    mount(null);
    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    await save();
    expect(
      await screen.findByText("Conflict: reload the envelope"),
    ).toBeTruthy();
    const first = setEnvelope.mock.calls[0]![2];
    await save();
    expect(setEnvelope.mock.calls[1]![2]).toEqual(first);
  });
  it("locks two synchronous submissions and does not select after project departure", async () => {
    let finish = () => {};
    setEnvelope.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    await edit();
    await level("0.2");
    const form = screen
      .getByRole("button", { name: "Save point" })
      .closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    act(() =>
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject()),
    );
    await act(async () => finish());
    expect(useDawStore.getState().selection).toBeNull();
  });
  it("removes the final point with an empty envelope command", async () => {
    hydrate([initial[0]!]);
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove volume envelope" }),
    );
    expect(setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [],
      [initial[0]!],
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelope",
      trackId: "host",
    });
  });
  it("defaults later additions to the bounded playhead and interpolated gain", async () => {
    useDawStore.setState({ playheadSec: 2.5 });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    expect(screen.getByLabelText("Time (seconds on timeline)")).toHaveValue(
      2.5,
    );
    expect(screen.getByLabelText("Level (×)")).toHaveValue(0.75);
  });
  it("keeps share envelope controls read-only even for an edit-capable share", () => {
    useDawStore.setState({ projectPath: "share:test", guestMode: "edit" });
    mount();
    expect(
      screen.getByText(
        "Volume envelope editing is available to the project owner.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add point" })).toBeNull();
    expect(setEnvelope).not.toHaveBeenCalled();
  });
});

it.each([
  ["Time (seconds on timeline)", "-1", "Time must"],
  ["Level (×)", "9", "Level must"],
])(
  "associates the %s error with the offending field",
  async (label, invalid, message) => {
    setEnvelope.mockReset();
    hydrate();
    mount();
    await edit();
    const input = screen.getByLabelText(label);
    await userEvent.clear(input);
    await userEvent.type(input, invalid);
    await save();
    expect(input).toHaveAttribute("aria-invalid", "true");
    const description = input.getAttribute("aria-describedby");
    expect(description).toBeTruthy();
    expect(document.getElementById(description!)?.textContent).toContain(
      message,
    );
    expect(setEnvelope).not.toHaveBeenCalled();
  },
);
