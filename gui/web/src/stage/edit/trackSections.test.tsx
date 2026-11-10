import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEffectBypass } from "../../api";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { ProjectView, TrackView } from "../../types/project";
import { inspectorHeading } from "./inspectorHeading";
import { SectionsBody } from "./SectionsBody";

const setTrackMetaCommand = vi.fn();
const setTrackFaderCommand = vi.fn(async (..._args: unknown[]) => ({}));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  setTrackMetaCommand: (...args: unknown[]) => setTrackMetaCommand(...args),
  setTrackFaderCommand: (...args: unknown[]) => setTrackFaderCommand(...args),
  setEffectBypass: vi.fn(async () => undefined),
}));

const hostTrack: TrackView = sampleTrack({
  id: "host",
  label: "Host",
  media_path: null,
});
const withAudio: TrackView = { ...hostTrack, media_path: "raw/host.wav" };

type Effects = ProjectView["effects_by_track"][string];

function open(
  track: TrackView = hostTrack,
  effects: Effects = [],
  access?: "view" | "edit",
  kind: "track" | "envelope" = "track",
  others: readonly TrackView[] = [],
) {
  const project = minimalProject({
    tracks: [track, ...others],
    effects_by_track: { [track.id]: effects },
  });
  if (access)
    useDawStore.getState().hydrate(shareProjectKey("tok"), project, access);
  else useDawStore.getState().hydrate("/tmp/ep.json", project);
  useDawStore.setState({
    selection: { kind, trackId: track.id },
    prepareFocusTrackId: null,
  });
  return render(<SectionsBody withRange={false} />);
}

beforeEach(() => {
  setTrackMetaCommand.mockReset();
  setTrackFaderCommand.mockClear();
  vi.mocked(setEffectBypass).mockClear();
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().setLayerVisible("showLevels", false);
});

afterEach(() => {
  clearRegisteredCommands();
});

describe("track content", () => {
  it("heads the sheet by the track label and names its native fields", async () => {
    const { container } = open();
    expect(
      inspectorHeading(
        { kind: "track", trackId: "host" },
        useDawStore.getState().project,
      ).name,
    ).toBe("Host");
    expect(screen.getByRole("group", { name: "Kind" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "Level" })).toBeVisible();
    await expectNoA11yViolations(container);
  });

  it("shows Kind as a group with Voice pressed on a dialogue track and sends the role for Music", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockResolvedValue({});
    open();
    const group = screen.getByRole("group", { name: "Kind" });
    expect(
      within(group).getByRole("button", { name: "Voice" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(group).getByRole("button", { name: "Music" }),
    ).toHaveAttribute("aria-pressed", "false");
    await user.click(within(group).getByRole("button", { name: "Music" }));
    expect(setTrackMetaCommand).toHaveBeenCalledExactlyOnceWith(
      "/tmp/ep.json",
      "host",
      { role: "music" },
    );
  });

  it("lists the episode's people with this track's speaker checked and sends the picked name", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockResolvedValue({});
    const { container } = open(
      { ...hostTrack, speaker: "Mira" },
      [],
      undefined,
      "track",
      [sampleTrack({ id: "guest", label: "Guest", speaker: "Tomas" })],
    );
    await expectNoA11yViolations(container);
    const people = screen.getByRole("radiogroup", {
      name: "Person",
    });
    expect(
      within(people)
        .getAllByRole("radio")
        .map((radio) => [
          radio.querySelector(".sys-picker-name")?.textContent,
          radio.getAttribute("aria-checked"),
        ]),
    ).toEqual([
      ["Mira", "true"],
      ["Tomas", "false"],
    ]);
    await user.click(within(people).getByRole("radio", { name: /Tomas/ }));
    expect(setTrackMetaCommand).toHaveBeenCalledExactlyOnceWith(
      "/tmp/ep.json",
      "host",
      { speaker: "Tomas" },
    );
    await user.click(within(people).getByRole("radio", { name: /Mira/ }));
    expect(setTrackMetaCommand).toHaveBeenCalledTimes(1);
  });

  it("adds a new person from Add person on Enter", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockResolvedValue({});
    open({ ...hostTrack, speaker: "Mira" });
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(
      screen.getByRole("textbox", { name: "Name of the new person" }),
      "Priya{Enter}",
    );
    expect(setTrackMetaCommand).toHaveBeenCalledExactlyOnceWith(
      "/tmp/ep.json",
      "host",
      { speaker: "Priya" },
    );
    expect(screen.getByRole("button", { name: "Add person" })).toHaveFocus();
  });

  it("keeps the typed name open with the reason when the host refuses Add person", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockRejectedValue(
      new Error("Only the host can do that"),
    );
    open({ ...hostTrack, speaker: "Mira" });
    await user.click(screen.getByRole("button", { name: "Add person" }));
    const field = screen.getByRole("textbox", {
      name: "Name of the new person",
    });
    await user.type(field, "Priya{Enter}");
    expect(
      await screen.findAllByText("Only the host can do that"),
    ).not.toHaveLength(0);
    expect(field).toHaveValue("Priya");
    expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
  });

  it("sends one speaker write while the first is still saving", async () => {
    const user = userEvent.setup();
    let settle: (value: object) => void = () => undefined;
    setTrackMetaCommand.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    open({ ...hostTrack, speaker: "Mira" }, [], undefined, "track", [
      sampleTrack({ id: "guest", label: "Guest", speaker: "Tomas" }),
      sampleTrack({ id: "third", label: "Third", speaker: "Priya" }),
    ]);
    const people = screen.getByRole("radiogroup", { name: "Person" });
    await user.click(within(people).getByRole("radio", { name: /Tomas/ }));
    await user.click(within(people).getByRole("radio", { name: /Priya/ }));
    expect(setTrackMetaCommand).toHaveBeenCalledTimes(1);
    settle({});
  });

  it("sends nothing when Add person is given the track's own speaker", async () => {
    const user = userEvent.setup();
    open({ ...hostTrack, speaker: "Mira" });
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(
      screen.getByRole("textbox", { name: "Name of the new person" }),
      "mira{Enter}",
    );
    expect(setTrackMetaCommand).not.toHaveBeenCalled();
  });

  it("has no empty Person row when the episode has no people", () => {
    const { container } = open({ ...hostTrack, speaker: null });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("button", { name: "Add person" })).toBeVisible();
    const rows = [...container.querySelectorAll(".sys-inspector-row")];
    expect(rows.filter((row) => row.children.length === 0)).toEqual([]);
    expect(rows.filter((row) => row.textContent?.trim() === "").length).toBe(0);
  });

  it("picks the existing person when the typed name matches one, ignoring case", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockResolvedValue({});
    open({ ...hostTrack, speaker: null }, [], undefined, "track", [
      sampleTrack({ id: "guest", label: "Guest", speaker: "Mira" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(
      screen.getByRole("textbox", { name: "Name of the new person" }),
      "mira{Enter}",
    );
    expect(setTrackMetaCommand).toHaveBeenCalledExactlyOnceWith(
      "/tmp/ep.json",
      "host",
      { speaker: "Mira" },
    );
  });

  it("refuses an empty name and returns focus to Add person on Escape", async () => {
    const user = userEvent.setup();
    open({ ...hostTrack, speaker: "Mira" });
    await user.click(screen.getByRole("button", { name: "Add person" }));
    await user.type(
      screen.getByRole("textbox", { name: "Name of the new person" }),
      "{Enter}",
    );
    expect(screen.getByText("Enter a person's name.")).toBeVisible();
    expect(setTrackMetaCommand).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Add person" })).toHaveFocus();
  });

  it("has no Person row or Add person on a music track", () => {
    open({ ...hostTrack, role: "music", speaker: "Mira" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "Kind" })).getByRole("button", {
        name: "Music",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps an intro track on Music and sends nothing for Music, but writes dialogue for Voice", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockResolvedValue({});
    open({ ...hostTrack, role: "intro" });
    const group = screen.getByRole("group", { name: "Kind" });
    expect(
      within(group).getByRole("button", { name: "Music" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(within(group).getByRole("button", { name: "Music" }));
    expect(setTrackMetaCommand).not.toHaveBeenCalled();
    await user.click(within(group).getByRole("button", { name: "Voice" }));
    expect(setTrackMetaCommand).toHaveBeenCalledExactlyOnceWith(
      "/tmp/ep.json",
      "host",
      { role: "dialogue" },
    );
  });

  it("opens the same sheet for the track-level envelope selection", () => {
    open(hostTrack, [], undefined, "envelope");
    expect(screen.getByRole("spinbutton", { name: "Level" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show volume envelope" }),
    ).toBeVisible();
  });

  it("leaves the body to the range fields while a range is armed", () => {
    open();
    act(() => {
      useDawStore.setState({ rangeArmed: true });
    });
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    act(() => {
      useDawStore.setState({ rangeArmed: false });
    });
  });

  it("says when the track is gone", () => {
    open();
    act(() => {
      useDawStore.setState({ selection: { kind: "track", trackId: "nope" } });
    });
    expect(screen.getByText("Track not found")).toBeVisible();
  });

  it("starts with the envelope hidden and changes visibility without changing the project", async () => {
    const user = userEvent.setup();
    expect(useDawStore.getInitialState().layers.showLevels).toBe(false);
    open();
    const project = useDawStore.getState().project;
    await user.click(
      screen.getByRole("button", { name: "Show volume envelope" }),
    );
    expect(useDawStore.getState().layers.showLevels).toBe(true);
    expect(useDawStore.getState().project).toBe(project);
    await user.click(
      screen.getByRole("button", { name: "Hide volume envelope" }),
    );
    expect(useDawStore.getState().layers.showLevels).toBe(false);
    expect(useDawStore.getState().project).toBe(project);
  });

  it("commits Level once as the fader write", async () => {
    open();
    const field = screen.getByRole("spinbutton", { name: "Level" });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    const input = screen.getByRole("textbox", { name: "Level" });
    fireEvent.change(input, { target: { value: "-6" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await vi.waitFor(() => {
      expect(setTrackFaderCommand).toHaveBeenCalledTimes(1);
    });
    expect(setTrackFaderCommand).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "host",
      -6,
    );
  });

  it("shows a rejected Level write as an alert", async () => {
    setTrackFaderCommand.mockRejectedValueOnce(new Error("offline"));
    open();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Level" }), {
        key: "Enter",
      });
    });
    const input = screen.getByRole("textbox", { name: "Level" });
    fireEvent.change(input, { target: { value: "3" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(await screen.findByRole("alert")).toBeVisible();
  });

  it("notes the staging gain, what the track plays at and the balance state", () => {
    const view = open({
      ...hostTrack,
      role: "dialogue",
      gain_db: -2,
      fader_db: -3,
      balance_stale: true,
      balance_measured_lufs: -24.5,
      balance_ungated: true,
    });
    expect(
      screen.getByText("Staging gain −2.0 dB; plays at −5.0 dB"),
    ).toBeVisible();
    expect(
      screen.getByText("Balance stale · -24.5 LUFS · ungated"),
    ).toBeVisible();
    view.unmount();
    open({ ...hostTrack, role: "music", gain_db: 0, fader_db: -3 }, [], "view");
    expect(
      screen.getByText(
        "Only the host and editors can change the volume. Staging gain 0.0 dB; plays at −3.0 dB",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/^Balance/)).toBeNull();
  });
  it("reads Mute and Solo from the shared buttons", () => {
    open();
    expect(screen.getByRole("button", { name: /^Mute/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Solo/ })).toBeVisible();
  });

  it("effect params read as text, not JSON", async () => {
    const { container } = open(hostTrack, [
      { effect: "acompressor", params: { threshold_db: -18, ratio: 3 } },
    ]);
    expect(screen.getByText("threshold -18 dB · ratio 3")).toBeInTheDocument();
    expect(container.textContent).not.toContain("{");
    await expectNoA11yViolations(container);
  });

  it("passes the effect name so per-effect units apply", () => {
    open(hostTrack, [{ effect: "deesser", params: { frequency: 0.5 } }]);
    expect(screen.getByText("frequency (0–1) 0.5")).toBeInTheDocument();
    expect(screen.queryByText(/0\.5 Hz/)).toBeNull();
  });

  it("bypasses an effect by its index and reads state as text for a viewer", async () => {
    const user = userEvent.setup();
    const effects: Effects = [
      { effect: "acompressor", params: {} },
      { effect: "deesser", params: {}, bypass: true },
    ];
    const { unmount } = open(hostTrack, effects);
    await user.click(
      screen.getByRole("checkbox", { name: "Bypass acompressor" }),
    );
    expect(setEffectBypass).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "host",
      0,
      true,
    );
    expect(
      screen.getByRole("checkbox", { name: "Bypass deesser" }),
    ).toBeChecked();
    unmount();
    open(hostTrack, effects, "view");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("active")).toBeVisible();
    expect(screen.getByText("bypassed")).toBeVisible();
  });

  it("shows a failed bypass as an alert", async () => {
    const user = userEvent.setup();
    vi.mocked(setEffectBypass).mockRejectedValueOnce(new Error("no write"));
    open(hostTrack, [{ effect: "acompressor", params: {} }]);
    await user.click(
      screen.getByRole("checkbox", { name: "Bypass acompressor" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("no write");
  });

  it("warns when a saved chain contains an unsupported effect", () => {
    const warning =
      "Unsupported effect 'volume' will not be rendered. Remove it from this chain before export.";
    open(hostTrack, [
      { effect: "volume", params: {}, supported: false, warning },
    ]);
    expect(screen.getByText(warning)).toHaveAttribute("role", "status");
  });

  it("offers Import or Replace audio to an editor and leaves Remove track to the Action bar", () => {
    const { unmount } = open();
    expect(screen.getByRole("button", { name: "Import audio…" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove track" })).toBeNull();
    unmount();
    open(withAudio);
    expect(
      screen.getByRole("button", { name: "Replace audio…" }),
    ).toBeVisible();
  });

  describe("Split speakers…", () => {
    it("opens Prepare at the split prompt for a track that has audio", async () => {
      const user = userEvent.setup();
      open(withAudio);
      await user.click(screen.getByRole("button", { name: "Split speakers…" }));
      expect(useDawStore.getState().prepareFocusTrackId).toBe("host");
      expect(useDawStore.getState().stage).toBe("prepare");
    });

    it.each([
      [hostTrack, "Import this track's audio first"],
      [
        { ...withAudio, speaker_split_id: "split_1" },
        "This track is already split by speaker. Undo the split to split it again.",
      ],
    ])("is disabled with its reason beside it: %#", (track, reason) => {
      open(track);
      const button = screen.getByRole("button", { name: "Split speakers…" });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
      expect(screen.getByText(reason, { selector: "p" })).toBeVisible();
    });

    it("is not offered on a review link", () => {
      open(withAudio, [], "edit");
      expect(
        screen.queryByRole("button", { name: "Split speakers…" }),
      ).toBeNull();
    });
  });

  it("shows the kind as plain text and hides the kind group, name, speaker, import, split and remove controls for a viewer", () => {
    open({ ...withAudio, speaker: "Mira" }, [], "view");
    expect(screen.getByText("Kind")).toBeVisible();
    expect(screen.getByText("Voice")).toBeVisible();
    expect(screen.getByText("Mira")).toBeVisible();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Kind" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Role" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Speaker" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go to start" })).toBeNull();
    expect(screen.queryByText("Stem")).toBeNull();
    expect(screen.queryByText("Media")).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace audio…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove track" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Smooth all joins" }),
    ).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Level" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
  });
});
