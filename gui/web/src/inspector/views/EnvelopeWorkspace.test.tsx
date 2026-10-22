import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    useDawStore.getState().setLayerVisible("showLevels", true);
  });
  it("opens an empty workspace without saving; first draft defaults to zero/unity and cancels", async () => {
    hydrate([], null);
    const { container } = mount(null);
    expect(setEnvelope).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    expect(screen.getByLabelText("Time (seconds on timeline)")).toHaveValue(
      "0",
    );
    expect(screen.getByLabelText("Level (×)")).toHaveValue("1");
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
    expect(next).toEqual([
      { id: expect.any(String), time: 0, value: 1 },
      { id: expect.any(String), time: 10, value: 1 },
    ]);
    expect(next[1]!.id).not.toBe(next[0]!.id);
    expect(setEnvelope).toHaveBeenCalledWith("/tmp/p.json", "host", next, []);
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      pointId: next[0]!.id,
    });
  });
  it("keeps the workspace hidden and blocks saving until the envelope is shown", async () => {
    hydrate([], null);
    useDawStore.getState().setLayerVisible("showLevels", false);
    const workspace = mount(null);

    expect(screen.getByRole("button", { name: "Add point" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Show volume envelope" }),
    );
    expect(useDawStore.getState().layers.showLevels).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    expect(screen.getByLabelText("Level (×)")).toHaveValue("1");
    await time("5");
    await userEvent.click(
      screen.getByRole("button", { name: "Hide volume envelope" }),
    );
    expect(useDawStore.getState().layers.showLevels).toBe(false);
    expect(screen.getByRole("button", { name: "Save point" })).toBeDisabled();
    expect(setEnvelope).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Show volume envelope" }),
    );
    await save();
    const flat = setEnvelope.mock.calls[0]![2] as AutomationPoint[];
    expect(flat.map(({ time: at, value }) => ({ time: at, value }))).toEqual([
      { time: 0, value: 1 },
      { time: 5, value: 1 },
      { time: 10, value: 1 },
    ]);
    expect(setEnvelope.mock.calls[0]![3]).toEqual([]);
    hydrate(flat, flat[1]!.id);
    workspace.rerender(
      <EnvelopeWorkspace trackId="host" pointId={flat[1]!.id} />,
    );
    await edit();
    expect(screen.getByLabelText("Level (×)")).toHaveValue("1");
    await level("0.5");
    await save();
    expect(setEnvelope.mock.calls[1]![3]).toEqual(flat);
    expect(setEnvelope.mock.calls[1]![2]).toEqual([
      { ...flat[0]!, value: 1 },
      { ...flat[1]!, value: 0.5 },
      { ...flat[2]!, value: 1 },
    ]);
  });
  it("saves one existing envelope command for a half-dB nudge", async () => {
    hydrate([{ id: "late", time: 5, value: 0.5 }], "late");
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "0.5 dB higher" }),
    );
    await waitFor(() => expect(setEnvelope).toHaveBeenCalledTimes(1));
    expect(setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [{ id: "late", time: 5, value: 0.529627 }],
      [{ id: "late", time: 5, value: 0.5 }],
    );
  });
  it("keeps a submitted envelope nudge when the shared layer is hidden", async () => {
    hydrate([{ id: "late", time: 5, value: 1 }], "late");
    mount();
    let settle!: () => void;
    setEnvelope.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    const point = screen.getByRole("button", { name: "0.5 dB lower" });
    fireEvent.pointerDown(point, { button: 0, pointerId: 4 });
    fireEvent.pointerUp(point, { pointerId: 4 });
    await waitFor(() => expect(setEnvelope).toHaveBeenCalledTimes(1));
    expect(setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [{ id: "late", time: 5, value: 0.944061 }],
      [{ id: "late", time: 5, value: 1 }],
    );

    useDawStore.getState().setLayerVisible("showLevels", false);
    await act(async () => settle());
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).toEqual([{ id: "late", time: 5, value: 0.944061 }]);
    expect(setEnvelope).toHaveBeenCalledTimes(1);
  });
  it("reverts an active envelope nudge if the shared layer is hidden", async () => {
    hydrate([{ id: "late", time: 5, value: 1 }], "late");
    mount();
    const point = screen.getByRole("button", { name: "0.5 dB lower" });
    fireEvent.pointerDown(point, { button: 0, pointerId: 3 });
    useDawStore.getState().setLayerVisible("showLevels", false);
    fireEvent.pointerUp(point, { pointerId: 3 });

    await waitFor(() => expect(setEnvelope).not.toHaveBeenCalled());
    expect(
      useDawStore
        .getState()
        .project!.envelopes.find((envelope) => envelope.track_id === "host")
        ?.points,
    ).toEqual([{ id: "late", time: 5, value: 1 }]);
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
  it("keeps the typed draft when the workspace remounts, as the phone and tablet shells swap on rotation", async () => {
    const first = mount();
    await edit();
    await time("7");
    await level("0.25");
    first.unmount();
    mount();
    expect(screen.getByLabelText("Time (seconds on timeline)")).toHaveValue(
      "7",
    );
    expect(screen.getByLabelText("Level (×)")).toHaveValue("0.25");
    await save();
    expect(setEnvelope.mock.calls[0]![2]).toEqual([
      { id: "early", time: 0, value: 1 },
      { id: "late", time: 7, value: 0.25 },
    ]);
  });
  it("keeps a save in flight busy across a remount, so a second Save is not dispatched", async () => {
    let settle: () => void = () => {};
    setEnvelope.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const first = mount();
    await edit();
    await level("0.25");
    await save();
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    first.unmount();
    mount();
    expect(screen.getByRole("button", { name: "Save point" })).toBeDisabled();
    await save();
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle();
    });
    await waitFor(() =>
      expect(useDawStore.getState().envelopeSaving).toBeNull(),
    );
  });
  it("clears the in-flight save when the request fails, so the draft can be saved again", async () => {
    setEnvelope.mockRejectedValueOnce(new Error("offline"));
    const first = mount();
    await edit();
    await level("0.25");
    await save();
    await waitFor(() =>
      expect(useDawStore.getState().envelopeSaving).toBeNull(),
    );
    first.unmount();
    mount();
    await save();
    expect(setEnvelope).toHaveBeenCalledTimes(2);
  });
  it("drops the draft on Cancel, so a remount opens no form", async () => {
    const first = mount();
    await edit();
    await level("0.25");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    first.unmount();
    mount();
    expect(screen.queryByLabelText("Level (×)")).toBeNull();
  });
  it("drops the draft once the selection leaves its point", async () => {
    const first = mount();
    await edit();
    await level("0.25");
    first.unmount();
    act(() => {
      useDawStore.getState().setSelection({
        kind: "envelopePoint",
        trackId: "host",
        pointId: "early",
      });
    });
    act(() => {
      useDawStore.getState().setSelection({
        kind: "envelopePoint",
        trackId: "host",
        pointId: "late",
      });
    });
    mount();
    expect(screen.queryByLabelText("Level (×)")).toBeNull();
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
    expect(screen.getByLabelText("Level (×)")).toHaveValue("0.25");
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
      "2.5",
    );
    expect(screen.getByLabelText("Level (×)")).toHaveValue("0.75");
  });
  it("keeps share envelope controls read-only even for an edit-capable share", () => {
    useDawStore.setState({ projectPath: "share:test", guestMode: "edit" });
    mount();
    expect(
      screen.getByText(
        "This link can view, but not edit, the volume envelope.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add point" })).toBeNull();
    expect(setEnvelope).not.toHaveBeenCalled();
  });
});

describe("EnvelopeWorkspace timeline bound (#1336)", () => {
  beforeEach(() => {
    setEnvelope.mockReset();
    setEnvelope.mockResolvedValue(undefined);
    hydrate();
  });
  it.each(["10.001", "40", "1e9"])(
    "refuses a time of %s past the 10 s timeline end with an inline error",
    async (value) => {
      mount();
      await edit();
      await time(value);
      await save();
      const input = screen.getByLabelText("Time (seconds on timeline)");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Time must be from 0 to 10 seconds, the end of the timeline.",
      );
      expect(input).toHaveValue(value);
      expect(setEnvelope).not.toHaveBeenCalled();
    },
  );
  it.each(["0", "10"])("saves a time of exactly %s", async (value) => {
    hydrate([{ id: "mid", time: 5, value: 0.5 }], "mid");
    mount("mid");
    await edit();
    await time(value);
    await save();
    expect(setEnvelope.mock.calls[0]![2]).toEqual([
      { id: "mid", time: Number(value), value: 0.5 },
    ]);
  });
  it("lets a point already past a shortened timeline change level but not move further out", async () => {
    hydrate([{ id: "stale", time: 18, value: 0.5 }], "stale");
    mount("stale");
    await edit();
    await level("0.25");
    await save();
    expect(setEnvelope.mock.calls[0]![2]).toEqual([
      { id: "stale", time: 18, value: 0.25 },
    ]);
    setEnvelope.mockClear();
    await edit();
    await time("19");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("end of the timeline");
    expect(setEnvelope).not.toHaveBeenCalled();
  });
  it("on touch opens the add form on its heading, not a numeric field, so no software keyboard opens", async () => {
    useDawStore.setState({ pointerKind: "coarse" });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    expect(screen.getByRole("heading", { name: "Add point" })).toHaveFocus();
    expect(
      screen.getByLabelText("Time (seconds on timeline)"),
    ).not.toHaveFocus();
  });
  it("on touch opens the edit form on its heading too", async () => {
    useDawStore.setState({ pointerKind: "coarse" });
    hydrate([{ id: "mid", time: 5, value: 0.5 }], "mid");
    mount("mid");
    await edit();
    expect(screen.getByRole("heading", { name: "Edit point" })).toHaveFocus();
    expect(
      screen.getByLabelText("Time (seconds on timeline)"),
    ).not.toHaveFocus();
  });
  it("with a mouse or keyboard still lands in the Time field", async () => {
    useDawStore.setState({ pointerKind: "fine" });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Add point" }));
    expect(screen.getByLabelText("Time (seconds on timeline)")).toHaveFocus();
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
