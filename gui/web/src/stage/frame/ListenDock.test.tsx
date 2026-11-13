import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { noComposer } from "../../test/composerStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { ProjectView } from "../../types/project";
import { PlayerBar } from "./PlayerBar";
import { SheetHost } from "./SheetHost";

function join(
  mode: "view" | "comment",
  stale = false,
  transcript: ProjectView["transcript"] = null,
) {
  useDawStore.getState().hydrate(
    "share:tok",
    minimalProject({
      timeline_duration_sec: 600,
      tracks: [sampleTrack({ stem_is_fresh: true })],
      render_status: {
        needs_rerender: true,
        reconciliation: { stale: false },
        premix: { exists: true, is_stale: stale },
      },
      chapters: [
        { title: "Cold open", time: 0 },
        { title: "Guest joins", time: 8 },
      ],
      transcript,
    }),
    mode,
    mode === "view" ? ["view"] : ["view", "comment"],
  );
  useDawStore.setState({
    stage: "review",
    playheadSec: 0,
    ...noComposer,
    isPlaying: false,
    playStartSec: null,
    openSheet: null,
    audioError: null,
  });
}

const WORDS: ProjectView["transcript"] = {
  utterances: [{ id: "u1" } as never],
};

function mount() {
  return render(
    <>
      <PlayerBar placement="dock" />
      <SheetHost />
    </>,
  );
}

beforeEach(() => {
  stubViewportShell("phone");
  useDawStore.setState({ shellBreakpoint: "phone" });
  clearRegisteredCommands();
  registerDawCommands();
});

describe("the Listen dock on a phone guest link", () => {
  it("has the scrubber and the transport and no Expand player", () => {
    join("comment");
    mount();
    expect(
      screen.getByRole("slider", { name: "Episode overview" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Comment at 0:00" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Expand player/ })).toBeNull();
  });

  it("gives a Viewer no Comment button", () => {
    join("view", false, WORDS);
    mount();
    expect(screen.queryByRole("button", { name: /^Comment/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Chapters" })).toBeVisible();
  });

  it.each([
    ["view", null],
    ["comment", null],
  ] as const)(
    "has no Chapters button when a %s link's middle is the chapter list",
    (mode, words) => {
      join(mode, false, words);
      mount();
      expect(screen.queryByRole("button", { name: "Chapters" })).toBeNull();
    },
  );

  it("shows the mix status as visible text", () => {
    join("comment", true);
    mount();
    expect(screen.getByText("Mix out of date")).toBeVisible();
  });

  it("opens the Chapters sheet, and a row seeks and closes it", async () => {
    const user = userEvent.setup();
    join("comment", false, WORDS);
    mount();
    await user.click(screen.getByRole("button", { name: "Chapters" }));
    expect(screen.getByRole("dialog", { name: "Chapters" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Guest joins/ }));
    expect(useDawStore.getState().playheadSec).toBe(8);
    expect(screen.queryByRole("dialog", { name: "Chapters" })).toBeNull();
  });

  it("pauses when Comment is tapped while playing, and pins the moment", async () => {
    const user = userEvent.setup();
    join("comment");
    useDawStore.setState({ isPlaying: true, playStartSec: 0, playheadSec: 5 });
    mount();
    await user.click(screen.getByRole("button", { name: "Comment at 0:05" }));
    await act(async () => {});
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().commentDraft).toMatchObject({ startSec: 5 });
    expect(useDawStore.getState().composer.draft?.resume).toBe(true);
  });
});
