import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { FeaturesContext } from "../../extensions/FeaturesContext";
import { FEATURE_SHARE_UI_MENU } from "../../extensions/features";
import { useRecordHostStore } from "../../record/hostStore";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { StageId } from "../../types/stage";
import { StageHost } from "./StageHost";

vi.mock("../../panels/ImpactPanel", () => ({
  ImpactPanel: () => <div>impact panel</div>,
}));
vi.mock("../../panels/TightenPanel", () => ({
  TightenPanel: () => <div>tighten panel</div>,
}));
vi.mock("../../panels/CommentsPanel", () => ({
  CommentsPanel: ({ guestShare }: { guestShare?: boolean }) => (
    <div>{guestShare ? "guest comments panel" : "comments panel"}</div>
  ),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  loadHostRecordState: vi.fn(
    async () => useRecordHostStore.getState().snapshot,
  ),
}));
vi.mock("../edit/EditWorkspace", () => ({
  EditWorkspace: () => <div>edit workspace</div>,
}));

const HOST_PATH = "/tmp/stage-hosts/episode.project.json";

function asHost(stage: StageId, tracks = [sampleTrack()]) {
  useDawStore.getState().hydrate(HOST_PATH, minimalProject({ tracks }));
  useDawStore.setState({ stage, guestMode: null });
}

function asGuest(stage: StageId, mode: "view" | "comment" | "edit") {
  useDawStore.getState().hydrate("share:abc", minimalProject());
  useDawStore.setState({ stage, guestMode: mode });
}

function mount(guestShare = false) {
  return render(
    <FeaturesContext.Provider
      value={{
        ready: true,
        manifest: { api_version: 1, features: [FEATURE_SHARE_UI_MENU] },
      }}
    >
      <StageHost guestShare={guestShare} />
    </FeaturesContext.Provider>,
  );
}

beforeEach(() => {
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useRecordHostStore.setState({ snapshot: null });
});

describe("StageHost gating", () => {
  it.each(["record", "prepare", "deliver"] as const)(
    "shows a Viewer link a Cover and no %s controls",
    (stage) => {
      asGuest(stage, "view");
      mount(true);
      expect(screen.getByText("This link can't open that")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
      expect(
        screen.queryByRole("group", { name: "Recording controls" }),
      ).toBeNull();
      expect(screen.queryByRole("list", { name: "Getting ready" })).toBeNull();
    },
  );

  it("shows loading, not the Cover, before the project and role are known", () => {
    useDawStore.setState({
      project: null,
      projectPath: "share:abc",
      guestMode: "view",
      stage: "edit",
    });
    const { container } = mount(true);
    expect(screen.queryByText("This link can't open that")).toBeNull();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("shows loading, not the Cover, when only the route says it is a link", () => {
    useDawStore.setState({
      project: null,
      projectPath: "share:abc",
      guestMode: null,
      stage: "edit",
    });
    const { container } = mount(true);
    expect(screen.queryByText("This link can't open that")).toBeNull();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("sends the Cover's button to the link's first allowed stage", async () => {
    asGuest("deliver", "comment");
    mount(true);
    await userEvent.click(screen.getByRole("button", { name: "Go to Review" }));
    expect(useDawStore.getState().stage).toBe("review");
  });

  it("lets an Editor link open Edit but not Prepare", () => {
    asGuest("edit", "edit");
    const { unmount } = mount(true);
    expect(screen.getByText("edit workspace")).toBeInTheDocument();
    unmount();
    asGuest("prepare", "edit");
    mount(true);
    expect(screen.getByText("This link can't open that")).toBeInTheDocument();
  });

  it("opens every stage for the host", () => {
    for (const [stage, text] of [
      ["record", "Looking for a record room…"],
      ["prepare", "Help the transcriber"],
      ["edit", "edit workspace"],
      ["review", "comments panel"],
      ["deliver", "Episode file"],
    ] as const) {
      asHost(stage);
      const { unmount } = mount();
      expect(screen.getByText(text)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("Review host", () => {
  it("gives the host three sections and writes the choice to the stage slice", async () => {
    asHost("review");
    mount();
    const tabs = within(
      screen.getByRole("tablist", { name: "Review sections" }),
    );
    expect(tabs.getAllByRole("tab")).toHaveLength(3);
    await userEvent.click(tabs.getByRole("tab", { name: /Impact/ }));
    expect(useDawStore.getState().reviewSection).toBe("impact");
    expect(screen.getByText("impact panel")).toBeInTheDocument();
  });

  it("gives a guest Comments only, even when the slice names Tighten", () => {
    asGuest("review", "comment");
    useDawStore.setState({ reviewSection: "tighten" });
    mount(true);
    expect(
      screen.queryByRole("tablist", { name: "Review sections" }),
    ).toBeNull();
    expect(screen.getByText("guest comments panel")).toBeInTheDocument();
    expect(screen.queryByText("tighten panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deliver" })).toBeNull();
  });

  it("marks sections that wait on the person", () => {
    asHost("review");
    useDawStore.getState().hydrate(
      HOST_PATH,
      minimalProject({
        tracks: [sampleTrack()],
        comments: [
          {
            id: "c1",
            time_sec: 1,
            body: "x",
            author: "Host",
            resolved: false,
          } as never,
        ],
      }),
    );
    mount();
    expect(screen.getByRole("tab", { name: /Comments/ })).toHaveTextContent(
      "●",
    );
  });
});

describe("Prepare host", () => {
  it("shows the import entry points and the Getting ready rows", () => {
    asHost("prepare");
    mount();
    expect(
      screen.getByRole("button", { name: /Import audio/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Record/ })).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Getting ready" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Advanced/ }),
    ).toBeInTheDocument();
  });

  it("goes to Record from the record entry point", async () => {
    asHost("prepare");
    mount();
    await userEvent.click(screen.getByRole("button", { name: /^Record/ }));
    expect(useDawStore.getState().stage).toBe("record");
  });

  it("offers the hand-off to Edit while it works, quietly, with its reason", () => {
    asHost("prepare");
    mount();
    const handoff = screen.getByRole("button", { name: /Edit/ });
    expect(handoff).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Still getting ready")).toBeInTheDocument();
  });

  it("hands off to Edit once everything is done", async () => {
    asHost("prepare");
    useDawStore.setState({
      project: minimalProject({
        tracks: [sampleTrack({ speaker: "Maya" })],
        transcript: {
          utterances: [
            {
              track_id: "host",
              speaker: "Maya",
              start: 0,
              end: 1,
              text: "Hello",
            },
          ],
        },
      }),
    });
    mount();
    await userEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(useDawStore.getState().stage).toBe("edit");
  });

  it("shows only the two large tiles for a project with no tracks", () => {
    asHost("prepare", []);
    mount();
    expect(
      screen.getByRole("button", { name: /Import audio/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Getting ready" })).toBeNull();
  });

  it("keeps a skeleton while the project loads", () => {
    asHost("prepare");
    useDawStore.setState({ project: null });
    const { container } = mount();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("list", { name: "Getting ready" })).toBeNull();
  });

  it("says the project could not load and retries", async () => {
    asHost("prepare");
    useDawStore.setState({ project: null });
    const onRetry = vi.fn();
    render(<StageHost loadFailure={{ message: "No answer.", onRetry }} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("Deliver host", () => {
  it("opens the export, bounce and share dialogs through their commands", async () => {
    asHost("deliver");
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await userEvent.click(screen.getByRole("button", { name: "Bounce…" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Share a listen link" }),
    );
    await waitFor(() => {
      const { chrome } = useDawStore.getState();
      expect([
        chrome.exportDialogOpen,
        chrome.bounceDialogOpen,
        chrome.shareDialogOpen,
      ]).toEqual([true, true, true]);
    });
  });

  it("sends an open row to the stage that fixes it", async () => {
    asHost("deliver");
    useDawStore.getState().hydrate(
      HOST_PATH,
      minimalProject({
        tracks: [sampleTrack()],
        edit_impact: {
          ...minimalProject().edit_impact,
          pending_review_count: 2,
        },
      }),
    );
    mount();
    const readiness = screen.getByRole("region", {
      name: /left\. You can still export/,
    });
    expect(within(readiness).getAllByRole("listitem")).toHaveLength(7);
    expect(within(readiness).getByText("0 of 2")).toBeInTheDocument();
    await userEvent.click(
      within(readiness).getByRole("button", { name: "Review" }),
    );
    expect(useDawStore.getState().stage).toBe("review");
    expect(useDawStore.getState().reviewSection).toBe("impact");
  });

  it("hides the listen link when the share feature is off", () => {
    asHost("deliver");
    render(
      <FeaturesContext.Provider
        value={{ ready: true, manifest: { api_version: 1, features: [] } }}
      >
        <StageHost />
      </FeaturesContext.Provider>,
    );
    expect(
      screen.queryByRole("button", { name: "Share a listen link" }),
    ).toBeNull();
  });
});

describe("Record host", () => {
  it("looks for the room, then offers to create one", async () => {
    asHost("record");
    mount();
    expect(
      await screen.findByRole("button", { name: "Create record room" }),
    ).toBeInTheDocument();
  });

  it("mounts the Room view inside the shell for an open room", () => {
    asHost("record");
    useRecordHostStore.setState({
      snapshot: {
        session_id: "s",
        state: "recording",
        take_index: 0,
        recording_ms: 5000,
        participants: [],
        caps: { recorded: 0, producers: 0 },
      },
    });
    mount();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByRole("main")).toBeNull();
    expect(
      screen.getByRole("group", { name: "Recording controls" }),
    ).toBeInTheDocument();
  });
});
