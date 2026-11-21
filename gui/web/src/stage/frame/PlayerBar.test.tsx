import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { executePointerCommand } from "../../commands/pointer";
import { registerDawCommands } from "../../commands/register";
import { useDawKeymapListener } from "../../keymap/listener";
import { useDawStore } from "../../state/dawStore";
import {
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../../test/fixtures";
import { NO_PREVIEW_ERROR } from "../../utils/audioErrorLabel";
import { PlayerBar } from "./PlayerBar";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/player-bar/episode.sharecut", minimalProject());
  useDawStore.setState({
    auditionMode: "mix",
    guestMode: null,
    shareCapabilities: null,
    audioError: null,
  });
});

afterEach(() => vi.restoreAllMocks());

const audition = () => useDawStore.getState().auditionMode;

function PlayerWithTimeline() {
  useDawKeymapListener();
  return (
    <>
      <div role="region" aria-label="Timeline" tabIndex={-1} />
      <PlayerBar />
    </>
  );
}

describe("PlayerBar", () => {
  it("hears the original while A is held and goes back to the mode it left", async () => {
    useDawStore.setState({ auditionMode: "fx" });
    render(<PlayerBar />);
    const a = screen.getByRole("button", { name: "A" });
    fireEvent.pointerDown(a, { button: 0 });
    await waitFor(() => expect(audition()).toBe("raw"));
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 600);
    fireEvent.pointerUp(a);
    await waitFor(() => expect(audition()).toBe("fx"));
  });

  it("latches the original on a quick press, and B goes back to the mix", async () => {
    const user = userEvent.setup();
    render(<PlayerBar />);
    await user.click(screen.getByRole("button", { name: "A" }));
    await waitFor(() => expect(audition()).toBe("raw"));
    await user.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() => expect(audition()).toBe("mix"));
  });

  it("picks Without mix processing from the hear menu", async () => {
    const user = userEvent.setup();
    render(<PlayerBar />);
    fireEvent.contextMenu(screen.getByRole("group", { name: "Audition" }));
    await user.click(
      await screen.findByRole("menuitemradio", {
        name: "Without mix processing",
      }),
    );
    await waitFor(() => expect(audition()).toBe("fx"));
  });

  it("waits on the project: Play says it is loading", () => {
    useDawStore.setState({ project: null });
    render(<PlayerBar />);
    const play = screen.getByRole("button", { name: "Play" });
    expect(play).toHaveAttribute("aria-disabled", "true");
    expect(play).toHaveAccessibleDescription("Loading…");
    expect(screen.getByText("Loading…")).toBeVisible();
  });

  it("gives a guest the mix only: no A/B and no hear menu", () => {
    useDawStore.setState({ guestMode: "edit" });
    render(<PlayerBar />);
    expect(screen.queryByRole("group", { name: "Audition" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hear options" })).toBeNull();
  });

  describe("source preview", () => {
    const inputs = ["Player", "Space", "palette"] as const;
    const previewAt = (episodePlaying: boolean, hasTrack = true) => {
      useDawStore
        .getState()
        .hydrate(
          "share:player-preview-test",
          minimalProject({ tracks: hasTrack ? [sampleTrack()] : [] }),
        );
      const transport = useDawStore.getState();
      transport.setPlayheadSec(12);
      transport.setIsPlaying(episodePlaying);
      transport.beginSourcePreview({
        ownerId: "selected-range",
        media: { kind: "rendered", url: "blob:range" },
        startSec: 0,
        endSec: 3,
      });
      transport.setTimelineFocused(true);
      return useDawStore.getState().sourcePreview!;
    };
    const press = async (input: (typeof inputs)[number], label: string) => {
      if (input === "Player") {
        await userEvent.click(screen.getByRole("button", { name: label }));
      } else if (input === "Space") {
        screen.getByRole("region", { name: "Timeline" }).focus();
        await userEvent.keyboard(" ");
      } else {
        await act(async () => {
          await executePointerCommand("transport.togglePlay");
        });
      }
    };

    it.each(inputs)(
      "pauses a preview with %s and leaves the episode paused",
      async (input) => {
        previewAt(false);
        render(<PlayerWithTimeline />);
        expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
        await press(input, "Pause");

        expect(screen.getByRole("button", { name: "Play" })).toBeVisible();
        expect(useDawStore.getState()).toMatchObject({
          sourcePreview: null,
          isPlaying: false,
          playheadSec: 12,
        });
      },
    );

    it.each(inputs)(
      "resumes the episode with %s after a preview ends",
      async (input) => {
        const preview = previewAt(true);
        useDawStore
          .getState()
          .updateSourcePreview(preview.ownerId, preview.generation, 3, true);
        render(<PlayerWithTimeline />);
        expect(screen.getByRole("button", { name: "Play" })).toBeVisible();
        await press(input, "Play");

        expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
        expect(useDawStore.getState()).toMatchObject({
          sourcePreview: null,
          isPlaying: true,
          playheadSec: 12,
        });
      },
    );

    it("can pause a playing preview even when the episode has no tracks", async () => {
      previewAt(false, false);
      render(<PlayerBar />);
      const pause = screen.getByRole("button", { name: "Pause" });
      expect(pause).not.toHaveAttribute("aria-disabled");
      await userEvent.click(pause);

      expect(
        screen.getByRole("button", { name: "Play" }),
      ).toHaveAccessibleDescription("Import audio to play.");
      expect(useDawStore.getState()).toMatchObject({
        sourcePreview: null,
        isPlaying: false,
        playheadSec: 12,
      });
    });

    it.each([false, true])(
      "plays the episode from its held position after a preview ends (episode was playing: %s)",
      async (episodePlaying) => {
        const preview = previewAt(episodePlaying);
        useDawStore
          .getState()
          .updateSourcePreview(preview.ownerId, preview.generation, 3, true);
        render(<PlayerBar />);
        await userEvent.click(screen.getByRole("button", { name: "Play" }));

        expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
        expect(useDawStore.getState()).toMatchObject({
          sourcePreview: null,
          isPlaying: true,
          playheadSec: 12,
        });
      },
    );

    it("retries episode audio while a source preview is held", async () => {
      previewAt(false);
      useDawStore.getState().setAudioError("Audio playback failed");
      render(<PlayerBar />);
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(useDawStore.getState()).toMatchObject({
        sourcePreview: null,
        audioError: null,
        isPlaying: true,
        playheadSec: 12,
      });
    });
  });

  describe("Comment", () => {
    const comment = () => screen.queryByRole("button", { name: "Comment" });

    it("shows for the host", () => {
      render(<PlayerBar />);
      expect(comment()).toBeInTheDocument();
    });

    it.each([
      ["edit", ["comment"], true],
      ["comment", ["comment"], true],
      ["comment", ["reply"], false],
      ["edit", [], false],
      ["view", [], false],
    ] as const)(
      "on a %s link with %j: shown is %s",
      (guestMode, caps, shown) => {
        useDawStore
          .getState()
          .hydrate("share:player-bar-token", minimalProject());
        useDawStore.setState({
          guestMode,
          shareCapabilities: [...caps],
        });
        render(<PlayerBar />);
        expect(comment() !== null).toBe(shown);
      },
    );

    it("starts a draft at the playhead and opens Comments", async () => {
      const user = userEvent.setup();
      useDawStore.setState({ stage: "edit", playheadSec: 3 });
      render(<PlayerBar />);
      await user.click(comment() as HTMLElement);
      await waitFor(() =>
        expect(useDawStore.getState().commentDraft).toMatchObject({
          startSec: 3,
        }),
      );
      expect(useDawStore.getState().stage).toBe("review");
    });
  });

  describe("suggestion ticks", () => {
    const edits = [
      pendingEditView({ id: "a", timeline_start: 15 }),
      pendingEditView({ id: "b", timeline_start: 15 }),
      pendingEditView({ id: "c", timeline_start: 30 }),
      pendingEditView({ id: "d", timeline_start: 45, applied: true }),
      pendingEditView({ id: "e", timeline_start: 50, review_required: false }),
      pendingEditView({
        id: "f",
        timeline_start: 55,
        unsure_words: [
          {
            track_id: "host",
            source_id: null,
            word_index: 0,
            text: "um",
            confidence: 0.3,
          },
        ],
      }),
      pendingEditView({ id: "g", timeline_start: null }),
    ];
    const ticks = async () => {
      const user = userEvent.setup();
      const { container } = render(<PlayerBar />);
      await user.click(screen.getByRole("button", { name: /Expand player/ }));
      return container.ownerDocument.querySelectorAll(
        ".sys-overview-tick--suggestion",
      );
    };
    const open = (
      key: string,
      guestMode: "edit" | "comment",
      caps: string[],
    ) => {
      useDawStore
        .getState()
        .hydrate(key, minimalProject({ pending_edits: edits }));
      useDawStore.setState({ guestMode, shareCapabilities: caps });
    };

    it("shows an Editor guest a tick per distinct qualifying edit", async () => {
      open("share:player-bar-token", "edit", ["comment", "edit"]);
      expect(await ticks()).toHaveLength(2);
    });

    it("shows a Commenter guest none", async () => {
      open("share:player-bar-token", "comment", ["comment"]);
      expect(await ticks()).toHaveLength(0);
    });

    it("shows the host none", async () => {
      open("/tmp/player-bar/episode.sharecut", "edit", ["comment", "edit"]);
      useDawStore.setState({ guestMode: null });
      expect(await ticks()).toHaveLength(0);
    });
  });

  describe("status", () => {
    it("says No mix yet when Play found no mix to play", () => {
      useDawStore
        .getState()
        .setProject(
          minimalProject({ tracks: [sampleTrack({ stem_is_fresh: true })] }),
        );
      useDawStore.setState({ audioError: NO_PREVIEW_ERROR });
      render(<PlayerBar />);
      expect(screen.getByText("No mix yet")).toBeVisible();
      expect(screen.queryByText("Audio error")).toBeNull();
    });

    it("says No mix yet for a project whose mix was never rendered", () => {
      useDawStore.getState().setProject(
        minimalProject({
          tracks: [sampleTrack()],
          render_status: {
            needs_rerender: false,
            reconciliation: { stale: false },
            premix: { exists: false },
          },
        }),
      );
      render(<PlayerBar />);
      expect(screen.getByText("No mix yet")).toBeVisible();
    });

    it("says Mix out of date for an old mix, and nothing for a fresh one", () => {
      useDawStore.getState().setProject(
        minimalProject({
          tracks: [sampleTrack({ stem_is_fresh: true })],
          render_status: {
            needs_rerender: true,
            reconciliation: { stale: false },
            premix: { exists: true },
          },
        }),
      );
      const { unmount } = render(<PlayerBar />);
      expect(screen.getByText("Mix out of date")).toBeVisible();
      unmount();
      useDawStore.getState().setProject(
        minimalProject({
          tracks: [sampleTrack({ stem_is_fresh: true })],
          render_status: {
            needs_rerender: false,
            reconciliation: { stale: false },
            premix: { exists: true },
          },
        }),
      );
      render(<PlayerBar />);
      expect(screen.queryByText(/Mix out of date|No mix yet/)).toBeNull();
    });

    it("gives an empty project's Play its reason as a description and a status line", () => {
      render(<PlayerBar />);
      const play = screen.getByRole("button", { name: "Play" });
      expect(play).toHaveAttribute("aria-disabled", "true");
      expect(play).toHaveAccessibleDescription("Import audio to play.");
      expect(screen.getByText("Import audio to play.")).toBeVisible();
    });

    it("leaves Play enabled when the mix is only stale", () => {
      useDawStore.getState().setProject(
        minimalProject({
          tracks: [sampleTrack({ stem_is_fresh: true })],
          render_status: {
            needs_rerender: true,
            reconciliation: { stale: false },
            premix: { exists: true },
          },
        }),
      );
      render(<PlayerBar />);
      expect(screen.getByRole("button", { name: "Play" })).not.toHaveAttribute(
        "aria-disabled",
      );
    });
  });
});
