import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEffectBypass } from "../../api";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { refreshDocumentDisplay } from "../../document/applyDocumentUpdate";
import {
  beginDocumentDraft,
  finishDocumentDraft,
} from "../../document/pendingDrafts";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { ProjectView, TrackView } from "../../types/project";
import { GUESTS_HEAR_FULL_MIX } from "../../utils/auditionModes";
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
) {
  const project = minimalProject({
    tracks: [track],
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
    expect(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Speaker" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Role" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "Level" })).toBeVisible();
    await expectNoA11yViolations(container);
  });

  it("offers the same five roles and saves a role on change", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockResolvedValue({});
    open();
    const select = screen.getByRole("combobox", { name: "Role" });
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "dialogue",
      "music",
      "sfx",
      "intro",
      "outro",
    ]);
    await user.selectOptions(select, "music");
    expect(setTrackMetaCommand).toHaveBeenCalledWith("/tmp/ep.json", "host", {
      role: "music",
    });
  });

  it("opens the same sheet for the track-level envelope selection", () => {
    open(hostTrack, [], undefined, "envelope");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Host");
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

  it("applies SetTrackMeta locally before the command resolves and reverts on failure", async () => {
    const user = userEvent.setup();
    let release!: (err?: Error) => void;
    const held = new Promise<Record<string, unknown>>((_, reject) => {
      release = (err?: Error) => {
        reject(err ?? new Error("network"));
      };
    });
    setTrackMetaCommand.mockImplementation(
      (_path: string, trackId: string, fields: Record<string, unknown>) => {
        beginDocumentDraft("meta", "SetTrackMeta", {
          track_id: trackId,
          ...fields,
        });
        return held.finally(() => {
          finishDocumentDraft("meta");
          refreshDocumentDisplay();
        });
      },
    );
    open();
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Narrator");
    expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Host");
    await user.tab();
    expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Narrator");
    expect(setTrackMetaCommand).toHaveBeenCalled();

    release(new Error("network"));
    await vi.waitFor(() => {
      expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Host");
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("network");
  });

  it("saves a rename on Enter and not when nothing changed", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockResolvedValue({});
    open();
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.click(input);
    await user.tab();
    expect(setTrackMetaCommand).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "Narrator{Enter}");
    expect(setTrackMetaCommand).toHaveBeenCalledTimes(1);
    expect(setTrackMetaCommand).toHaveBeenCalledWith("/tmp/ep.json", "host", {
      label: "Narrator",
      role: "dialogue",
      speaker: undefined,
    });
  });

  it("falls back to the track id for an emptied name", async () => {
    const user = userEvent.setup();
    setTrackMetaCommand.mockResolvedValue({});
    open();
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.tab();
    expect(setTrackMetaCommand).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "host",
      expect.objectContaining({ label: "host" }),
    );
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

  it("does not switch a guest to FX via Preview effects at track start", async () => {
    open(hostTrack, [], "view");
    const playFx = screen.getByRole("button", {
      name: "Preview effects at track start",
    });
    expect(playFx).toHaveAttribute("aria-disabled", "true");
    expect(playFx).toHaveAccessibleDescription(GUESTS_HEAR_FULL_MIX);
    expect(await execute("transport.audition", { mode: "fx" })).toEqual({
      status: "disabled",
      reason: GUESTS_HEAR_FULL_MIX,
    });
    expect(useDawStore.getState().auditionMode).toBe("mix");
  });

  it("Go to start moves the playhead to 0", async () => {
    const user = userEvent.setup();
    open();
    useDawStore.getState().setPlayheadSec(5);
    await user.click(screen.getByRole("button", { name: "Go to start" }));
    expect(useDawStore.getState().playheadSec).toBe(0);
  });

  it("stem freshness reads Up to date / Out of date / Unknown", () => {
    for (const [fresh, text] of [
      [true, "Up to date"],
      [false, "Out of date"],
      [null, "Unknown"],
    ] as const) {
      const { unmount } = open({ ...hostTrack, stem_is_fresh: fresh });
      expect(screen.getByText(text)).toBeInTheDocument();
      unmount();
    }
  });

  it("names the media path or none", () => {
    open(withAudio);
    expect(screen.getByText("raw/host.wav")).toBeVisible();
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

  it("shows the role as plain text and hides the name, speaker, role, import, split and remove controls for a viewer", () => {
    open(withAudio, [], "view");
    expect(screen.getByText("Role")).toBeVisible();
    expect(screen.getByText("dialogue")).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Role" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Speaker" })).toBeNull();
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
