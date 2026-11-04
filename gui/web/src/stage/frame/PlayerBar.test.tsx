import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
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
    audioError: null,
  });
});

afterEach(() => vi.restoreAllMocks());

const audition = () => useDawStore.getState().auditionMode;

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
    expect(play).toHaveAccessibleDescription("Loading project…");
    expect(screen.getByText("Loading project…")).toBeVisible();
  });

  it("gives a guest the mix only: no A/B and no hear menu", () => {
    useDawStore.setState({ guestMode: "edit" });
    render(<PlayerBar />);
    expect(screen.queryByRole("group", { name: "Audition" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hear options" })).toBeNull();
  });

  describe("suggestion ticks", () => {
    // The strip shows once the bar is expanded.
    const ticks = () => {
      fireEvent.click(screen.getByRole("button", { name: /Expand player/ }));
      return document.querySelectorAll(".sys-overview-tick--suggestion").length;
    };
    const withEdits = (path: string, guestMode: "edit" | "comment" | null) => {
      const base = minimalProject({ timeline_duration_sec: 100 });
      const edit = (id: string, start: number | null) =>
        ({
          ...(base.pending_edits?.[0] ?? {}),
          id,
          timeline_start: start,
          timeline_end: start === null ? null : start + 2,
          timeline_spans: [],
        }) as never;
      useDawStore.getState().hydrate(path, {
        ...base,
        pending_edits: [
          edit("a", 10),
          edit("b", 10),
          edit("c", 50),
          edit("d", null),
        ],
      });
      useDawStore.setState({
        guestMode,
        shareCapabilities:
          guestMode === "edit" ? ["comment", "edit"] : ["comment"],
      });
    };

    it("marks each suggestion's time for an Editor guest, once per time", () => {
      withEdits("share:player-ticks-token", "edit");
      render(<PlayerBar />);
      expect(ticks()).toBe(2);
    });

    it("shows none to a Commenter guest or the host", () => {
      withEdits("share:player-ticks-token", "comment");
      const { unmount } = render(<PlayerBar />);
      expect(ticks()).toBe(0);
      unmount();
      withEdits("/tmp/player-bar/episode.sharecut", null);
      render(<PlayerBar />);
      expect(ticks()).toBe(0);
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
