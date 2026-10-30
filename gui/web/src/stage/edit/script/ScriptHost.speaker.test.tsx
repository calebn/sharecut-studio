import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import { sampleTrack } from "../../../test/fixtures";
import { seedScript } from "../../../test/scriptHostKit";
import { ScriptHost } from "./ScriptHost";

const setTrackMeta = vi.hoisted(() => vi.fn());
const moveLane = vi.hoisted(() => vi.fn());
vi.mock("../../../api", async (original) => ({
  ...(await original<typeof import("../../../api")>()),
  setTrackMetaCommand: setTrackMeta,
}));
vi.mock("../../../commands/speakerMoveLaneSpan", () => ({
  runMoveSpeakerLaneSpan: moveLane,
}));
vi.mock("../../../commands/seek", () => ({ seekTransport: vi.fn() }));

const speakerButton = (name: string) =>
  screen.getAllByRole("button", { name: `${name}, change speaker` })[0]!;

function seedSplit() {
  seedScript({
    project: {
      tracks: [
        sampleTrack({ id: "host", speaker: "Maya", speaker_split_id: "s1" }),
        sampleTrack({ id: "guest", speaker: "Anneke", speaker_split_id: "s1" }),
        sampleTrack({ id: "other", speaker: "Zed" }),
      ],
    },
  });
}

beforeEach(() => {
  setTrackMeta.mockReset();
  moveLane.mockReset();
  setTrackMeta.mockResolvedValue({});
  moveLane.mockResolvedValue({ status: "ok" });
  seedSplit();
});

describe("ScriptHost speaker popover", () => {
  it("lists the turn's speaker and its sibling lanes, not other tracks", async () => {
    render(<ScriptHost />);
    await userEvent.click(speakerButton("Maya"));
    expect(screen.getByRole("radio", { name: /Maya/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Anneke/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Zed/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add speaker" })).toBeNull();
  });

  it("renames one track's speaker and announces it", async () => {
    render(<ScriptHost />);
    await userEvent.click(speakerButton("Maya"));
    await userEvent.click(
      screen.getAllByRole("button", { name: /Fix text/ })[0]!,
    );
    const field = screen.getByRole("textbox", { name: "Name for Maya" });
    await userEvent.clear(field);
    await userEvent.type(field, "Maia{Enter}");
    await waitFor(() =>
      expect(setTrackMeta).toHaveBeenCalledWith("/tmp/ep", "host", {
        speaker: "Maia",
      }),
    );
    expect(setTrackMeta).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("Speaker renamed to Maia"),
    ).toBeInTheDocument();
  });

  it("keeps the popover open with the reason when the rename fails", async () => {
    setTrackMeta.mockRejectedValue(new Error("The host said no."));
    render(<ScriptHost />);
    await userEvent.click(speakerButton("Maya"));
    await userEvent.click(
      screen.getAllByRole("button", { name: /Fix text/ })[0]!,
    );
    const field = screen.getByRole("textbox", { name: "Name for Maya" });
    await userEvent.type(field, "x{Enter}");
    expect(
      await screen.findByText(/did not save|host said no/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Name for Maya" }),
    ).toBeInTheDocument();
  });

  it("moves the turn to a sibling lane by selecting the turn first", async () => {
    render(<ScriptHost />);
    await userEvent.click(speakerButton("Maya"));
    await userEvent.click(screen.getByRole("radio", { name: /Anneke/ }));
    await waitFor(() => expect(moveLane).toHaveBeenCalledWith("guest"));
    expect(useDawStore.getState().selection).toEqual({
      kind: "transcriptRange",
      trackId: "host",
      sourceId: null,
      startWordIndex: 0,
      endWordIndex: 5,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the popover open with the command's reason when the move is refused", async () => {
    moveLane.mockResolvedValue({
      status: "disabled",
      reason: "Range action in progress",
    });
    render(<ScriptHost />);
    await userEvent.click(speakerButton("Maya"));
    await userEvent.click(screen.getByRole("radio", { name: /Anneke/ }));
    expect(
      await screen.findByText("Range action in progress"),
    ).toBeInTheDocument();
  });

  it("puts focus back on the margin name when it closes", async () => {
    render(<ScriptHost />);
    await userEvent.click(speakerButton("Maya"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(speakerButton("Maya")).toHaveFocus());
  });

  it("opens as a bottom sheet on the phone", async () => {
    render(<ScriptHost layout="phone" />);
    await userEvent.click(speakerButton("Maya"));
    expect(screen.getByRole("dialog", { name: "Speaker" })).toBeInTheDocument();
  });

  it("does not say the speaker was renamed when the project is not open", async () => {
    render(<ScriptHost />);
    await userEvent.click(speakerButton("Maya"));
    await userEvent.click(
      screen.getAllByRole("button", { name: /Fix text/ })[0]!,
    );
    const field = screen.getByRole("textbox", { name: "Name for Maya" });
    useDawStore.setState({ projectEditBasis: () => null });
    await userEvent.type(field, "x{Enter}");
    expect(await screen.findByText(/project is not open/i)).toBeInTheDocument();
    expect(setTrackMeta).not.toHaveBeenCalled();
    expect(screen.queryByText(/Speaker renamed/)).toBeNull();
  });
});
