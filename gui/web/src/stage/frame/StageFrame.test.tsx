import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sessionRoster } from "../../test/fixtures";
import { stubMatchMedia } from "../../test/matchMedia";
import type { HistoryEntryId } from "../../types/project";
import { _resetCoachTipsForTests } from "../../utils/coachTip";
import { StageFrame } from "./StageFrame";

vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadGuestAttention: vi.fn(async () => ({ pending: 0, conflicts: [] })),
}));

const PROJECT_PATH = "/tmp/stage-frame/episode.sharecut";

function mount() {
  return render(
    <StageFrame>
      {() => (
        <>
          <p>stage body</p>
        </>
      )}
    </StageFrame>,
  );
}

function saveDot(header: HTMLElement) {
  return within(header)
    .getAllByRole("status")
    .find((el) => el.classList.contains("sys-save")) as HTMLElement;
}

function bar() {
  return screen.getAllByRole("tablist", { name: "Stages" })[0];
}

beforeEach(() => {
  localStorage.clear();
  _resetCoachTipsForTests();
  stubMatchMedia(false);
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(PROJECT_PATH, minimalProject());
  useDawStore.setState({ stage: "edit", guestMode: null });
});

describe("StageFrame late word failure", () => {
  const failure = (projectPath: string) => ({
    projectPath,
    trackId: "t1",
    sourceId: null,
    wordIndex: 0,
    originalText: "hello",
    message: "Could not ignore \u201chello\u201d: offline",
  });
  const settle = (projectPath: string) =>
    act(() =>
      useDawStore
        .getState()
        .setTranscriptInlineEditFailure(failure(projectPath)),
    );

  beforeEach(() => {
    useDawStore.setState({
      transcriptInlineEditFailure: null,
      statusAnnouncement: "",
      feedbackToast: null,
    });
  });

  it("shows a failure that settles with no Script mounted as an error toast, once", () => {
    mount();
    settle(PROJECT_PATH);
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Could not ignore \u201chello\u201d: offline",
      tone: "error",
    });
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
  });

  it("says a failure that settled before the frame mounted", () => {
    settle(PROJECT_PATH);
    mount();
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      tone: "error",
    });
  });

  it("drops a failure from another project without a toast", () => {
    mount();
    settle("/tmp/other.sharecut");
    expect(useDawStore.getState().feedbackToast).toBeNull();
    expect(useDawStore.getState().transcriptInlineEditFailure).toBeNull();
  });
});

describe("StageFrame header", () => {
  it("shows the title, the Stage bar, Invite and search around the stage body", () => {
    mount();
    expect(
      screen.getByRole("button", { name: /Test Episode/ }),
    ).toBeInTheDocument();
    expect(within(bar()).getAllByRole("tab")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Edit" }).textContent).toBe(
      "stage body",
    );
  });

  it("opens the command palette from the search button", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /Palette/ }));
    await waitFor(() =>
      expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(true),
    );
  });

  it("disables Undo and Redo when the history has nothing to move", () => {
    mount();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it.each([
    ["view", "a live link", ["view"], /^Saved$/],
    ["comment", "a live link", ["comment"], /^Saved$/],
    ["edit", "a live link", ["edit"], /^Saved$/],
    ["view", "a saved copy", null, /Saved copy.*read-only/],
    ["comment", "a saved copy", null, /Saved copy.*read-only/],
    ["edit", "a saved copy", null, /Saved copy.*read-only/],
  ] as const)(
    "shows the Save dot to a %s guest on %s",
    async (guestMode, _name, caps, text) => {
      useDawStore.getState().hydrate("share:tok-s5", minimalProject(), null);
      useDawStore.setState({
        guestMode,
        stage: "review",
        shareCapabilities: caps ? [...caps] : null,
      });
      mount();
      const header = screen.getAllByRole("banner")[0];
      await waitFor(() => expect(saveDot(header)).toHaveTextContent(text));
    },
  );

  it("keeps the Save dot in the phone header for a guest", async () => {
    stubMatchMedia(true);
    useDawStore.getState().hydrate("share:tok-s5", minimalProject(), null);
    useDawStore.setState({
      guestMode: "comment",
      stage: "review",
      shareCapabilities: ["comment"],
    });
    mount();
    expect(document.querySelector(".stage-frame--phone")).not.toBeNull();
    const header = screen.getAllByRole("banner")[0];
    await waitFor(() => expect(saveDot(header)).toHaveTextContent(/^Saved$/));
  });
});

describe("StageFrame stage switching", () => {
  it("switches stage through the Stage bar", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(within(bar()).getByRole("tab", { name: /Review/ }));
    expect(useDawStore.getState().stage).toBe("review");
    expect(within(bar()).getByRole("tab", { name: /Review/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("main", { name: "Review" })).toBeInTheDocument();
  });

  it("calls openStage with the chosen stage", async () => {
    const user = userEvent.setup();
    const openStage = vi.fn(useDawStore.getState().openStage);
    useDawStore.setState({ openStage });
    mount();
    await user.click(within(bar()).getByRole("tab", { name: /Prepare/ }));
    expect(openStage).toHaveBeenCalledWith("prepare", {});
  });

  it("hides the Player on Record and shows it elsewhere", async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.getByRole("group", { name: "Player" })).toBeInTheDocument();
    await user.click(within(bar()).getByRole("tab", { name: /Record/ }));
    expect(screen.queryByRole("group", { name: "Player" })).toBeNull();
    await user.click(within(bar()).getByRole("tab", { name: /Deliver/ }));
    expect(screen.getByRole("group", { name: "Player" })).toBeInTheDocument();
  });

  it("badges Review with the decisions waiting", () => {
    useDawStore.getState().hydrate(
      PROJECT_PATH,
      minimalProject({
        edit_impact: {
          pending_review_count: 2,
          total_removed_sec: 0,
          by_track_sec: {},
        },
      }),
    );
    useDawStore.setState({ stage: "edit", guestMode: null });
    mount();
    expect(
      within(bar()).getByRole("tab", { name: /Review.*2, Needs you/ }),
    ).toBeInTheDocument();
  });
});

describe("StageFrame roles", () => {
  afterEach(() => {
    for (const role of ["viewer", "commenter", "editor"]) {
      localStorage.removeItem(`sharecut.roleHintSeen.${role}`);
    }
  });

  it("shows an Editor link Edit, Review and Deliver", () => {
    useDawStore.setState({ guestMode: "edit" });
    mount();
    expect(
      within(bar())
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("title")),
    ).toEqual(["Edit", "Review", "Deliver"]);
  });

  it("gives an Editor link no Invite: only the host shares", () => {
    useDawStore.setState({ guestMode: "edit" });
    mount();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("gives a Viewer link no Stage bar at all", () => {
    useDawStore.setState({ guestMode: "view", stage: "review" });
    mount();
    expect(screen.queryByRole("tablist", { name: "Stages" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("drops A/B for a guest, who hears the mix only", () => {
    useDawStore.setState({ guestMode: "comment", stage: "review" });
    mount();
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hear options" })).toBeNull();
  });

  it.each([
    ["view", "Viewer: can listen"],
    ["comment", "Commenter: can comment"],
    ["edit", "Editor: can edit"],
  ])("states a %s link's role in the header", (guestMode, name) => {
    useDawStore.setState({ guestMode, stage: "review" });
    mount();
    expect(screen.getByRole("img", { name })).toBeInTheDocument();
  });

  it("explains a guest's role once, until it is dismissed in this browser", async () => {
    localStorage.removeItem("sharecut.roleHintSeen.commenter");
    useDawStore.setState({ guestMode: "comment", stage: "review" });
    const first = mount();
    expect(
      screen.getByText("You can comment and suggest cuts. The host decides."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(
      screen.queryByText("You can comment and suggest cuts. The host decides."),
    ).toBeNull();
    first.unmount();
    mount();
    expect(
      screen.queryByText("You can comment and suggest cuts. The host decides."),
    ).toBeNull();
    localStorage.removeItem("sharecut.roleHintSeen.commenter");
  });

  it("explains a Viewer link and remembers only the viewer role", async () => {
    useDawStore.setState({ guestMode: "view", stage: "review" });
    mount();
    expect(
      screen.getByText("You can listen along. The host decides."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(localStorage.getItem("sharecut.roleHintSeen.viewer")).toBe("1");
    expect(localStorage.getItem("sharecut.roleHintSeen.commenter")).toBeNull();
    expect(localStorage.getItem("sharecut.roleHintSeen.editor")).toBeNull();
  });

  it("shows the hint when the guest role arrives after the first render", () => {
    localStorage.removeItem("sharecut.roleHintSeen.editor");
    useDawStore.setState({ guestMode: null, stage: "edit" });
    mount();
    expect(screen.queryByText(/The host decides/)).toBeNull();
    act(() => useDawStore.setState({ guestMode: "edit" }));
    expect(
      screen.getByText(
        "You can edit and comment. The host decides what ships.",
      ),
    ).toBeInTheDocument();
    localStorage.removeItem("sharecut.roleHintSeen.editor");
  });

  it("shows a host no role hint", () => {
    mount();
    expect(screen.queryByText(/The host decides/)).toBeNull();
  });

  it("puts the phone tab bar under the stage on a phone", () => {
    stubMatchMedia(true);
    mount();
    expect(document.querySelector(".stage-frame--phone")).not.toBeNull();
    expect(document.querySelectorAll(".sys-stage-bar--tabs")).toHaveLength(1);
  });
});

describe("StageFrame while following", () => {
  const follow = () =>
    act(() => {
      useDawStore.setState({
        followingClientId: "ada",
        sessionClients: sessionRoster([
          {
            client_id: "ada",
            role: "viewer",
            meta: { display_name: "Ada", color_index: 2 },
          },
        ]),
      });
    });

  afterEach(() => {
    useDawStore.setState({
      followingClientId: null,
      followDegraded: {},
      sessionClients: sessionRoster([]),
    });
  });

  it("outlines the stage in the followed person's color and drops it on unfollow", () => {
    mount();
    const frame = document.querySelector<HTMLElement>(".stage-frame");
    expect(frame?.classList.contains("stage-frame--following")).toBe(false);
    follow();
    expect(frame?.classList.contains("stage-frame--following")).toBe(true);
    expect(frame?.style.getPropertyValue("--stage-follow")).toBe(
      "var(--color-presence-2)",
    );
    act(() => useDawStore.setState({ followingClientId: null }));
    expect(frame?.classList.contains("stage-frame--following")).toBe(false);
  });

  it("puts a partial follow's reason on the Following pill for a guest", () => {
    useDawStore.setState({ guestMode: "view" });
    mount();
    follow();
    act(() =>
      useDawStore.setState({
        followDegraded: { tab: "pipeline", audition: "fx" },
      }),
    );
    const pill = screen
      .getByText("Following Ada")
      .closest(".sys-player-pill") as HTMLElement;
    expect(pill.title).toBe(
      "Following Ada · Listening in Mix · in Pipeline (host-only) · auditioning FX",
    );
    expect(
      screen.getByText(
        "Listening in Mix · in Pipeline (host-only) · auditioning FX",
        { selector: "[aria-live]" },
      ),
    ).toBeInTheDocument();
    expect(pill).toHaveTextContent("· Listening in Mix");
  });

  it("stops following from the pill", async () => {
    mount();
    follow();
    await userEvent.click(
      screen.getByRole("button", { name: "Stop following Ada" }),
    );
    await waitFor(() =>
      expect(useDawStore.getState().followingClientId).toBeNull(),
    );
  });
});

describe("StageFrame undo tip", () => {
  const head = "h1" as HistoryEntryId;
  const cut = (
    options: Parameters<
      ReturnType<typeof useDawStore.getState>["announceStatus"]
    >[1],
  ) =>
    act(() =>
      useDawStore.getState().announceStatus("Cut to clipboard", options),
    );

  beforeEach(() => {
    useDawStore.setState({ pointerKind: "coarse", feedbackToast: null });
  });

  it("points at the header Undo after an undoable edit on a phone", () => {
    stubMatchMedia(true);
    mount();
    expect(screen.queryByRole("note")).toBeNull();
    cut({ undo: head });
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Two-finger tap to undo");
    const header = screen.getAllByRole("banner")[0];
    expect(header).toContainElement(note);
    expect(note.closest(".sys-coach")).toContainElement(
      within(header).getByRole("button", { name: "Undo" }),
    );
  });

  it("says nothing on a tablet, where two-finger tap does not undo", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("1194"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    mount();
    cut({ undo: head });
    expect(document.querySelector(".stage-frame--tablet")).not.toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says nothing for a gesture toast or a change that only has reverse", () => {
    stubMatchMedia(true);
    mount();
    cut({ undo: head, gesture: true });
    expect(screen.queryByRole("note")).toBeNull();
    cut({ reverse: { run: async () => true, done: "Reverted" } });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("leaves the header's edge to the Role chip hint for a guest editor", () => {
    stubMatchMedia(true);
    useDawStore.getState().hydrate("share:tok-u2", minimalProject(), null);
    useDawStore.setState({
      guestMode: "edit",
      shareCapabilities: ["edit"],
      pointerKind: "coarse",
    });
    mount();
    cut({ undo: head });
    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("You can edit and comment");
    expect(screen.queryByText("Two-finger tap to undo")).toBeNull();
  });

  it("says nothing to a guest who cannot edit", () => {
    stubMatchMedia(true);
    useDawStore.getState().hydrate("share:tok-u", minimalProject(), null);
    useDawStore.setState({
      guestMode: "comment",
      shareCapabilities: ["comment"],
      pointerKind: "coarse",
    });
    mount();
    cut({ undo: head });
    expect(screen.queryByText("Two-finger tap to undo")).toBeNull();
  });
});
