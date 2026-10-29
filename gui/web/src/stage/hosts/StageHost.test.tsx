import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { FeaturesContext } from "../../extensions/FeaturesContext";
import { FEATURE_SHARE_UI_MENU } from "../../extensions/features";
import { useRecordHostStore } from "../../record/hostStore";
import { useDawStore } from "../../state/dawStore";
import { fakeExportServer } from "../../test/fakeExportServer";
import {
  minimalProject,
  pipelineJobSnapshot,
  sampleTrack,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { StageId } from "../../types/stage";
import { BounceFlowProvider } from "./bounceFlow";
import { ExportFlowProvider } from "./exportFlow";
import { StageHost } from "./StageHost";
import { ShareFlowProvider } from "./shareFlow";

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
      <ExportFlowProvider>
        <BounceFlowProvider>
          <ShareFlowProvider>
            <StageHost guestShare={guestShare} />
          </ShareFlowProvider>
        </BounceFlowProvider>
      </ExportFlowProvider>
    </FeaturesContext.Provider>,
  );
}

let server: ReturnType<typeof fakeExportServer>;

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useRecordHostStore.setState({ snapshot: null });
  useDawStore.setState({ pipelineJob: null });
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
      ["review", "Nothing to decide"],
      ["deliver", "Episode file"],
    ] as const) {
      asHost(stage);
      const { unmount } = mount();
      expect(screen.getAllByText(text)[0]).toBeInTheDocument();
      unmount();
    }
  });
});

describe("Review host", () => {
  it("gives the host two sections and writes the choice to the stage slice", async () => {
    asHost("review");
    mount();
    const tabs = within(
      screen.getByRole("tablist", { name: "Review sections" }),
    );
    expect(
      tabs
        .getAllByRole("tab")
        .map((t) => t.textContent)
        .join(),
    ).toMatch(/^Queue.*Comments$/);
    await userEvent.click(tabs.getByRole("tab", { name: /Queue/ }));
    expect(useDawStore.getState().reviewSection).toBe("queue");
    expect(screen.getByRole("region", { name: "Decision" })).toBeVisible();
  });

  it("gives a guest Comments only, even when the slice names Queue", () => {
    asGuest("review", "comment");
    useDawStore.setState({ reviewSection: "queue" });
    mount(true);
    expect(
      screen.queryByRole("tablist", { name: "Review sections" }),
    ).toBeNull();
    expect(screen.getByText("guest comments panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deliver" })).toBeNull();
  });

  it("puts the read-only Script above a guest's comments, and not above the host's", () => {
    useDawStore.getState().hydrate(
      "share:abc",
      minimalProject({
        transcript: {
          utterances: [
            {
              track_id: "t1",
              source_id: "s1",
              speaker: "Maya",
              start: 0,
              end: 0,
              text: "",
              words: [
                {
                  text: "Welcome",
                  start: 0,
                  end: 0,
                  timeline_start: 1,
                  timeline_end: 2,
                },
              ],
            },
          ],
        },
      }),
    );
    useDawStore.setState({ stage: "review", guestMode: "comment" });
    const { unmount } = mount(true);
    const script = screen.getByRole("button", { name: "Welcome" });
    const comments = screen.getByText("guest comments panel");
    expect(
      script.compareDocumentPosition(comments) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount();
    asHost("review");
    mount();
    expect(screen.queryByRole("button", { name: "Welcome" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Nothing to read yet" }),
    ).toBeNull();
  });

  it.each([
    [false, false],
    [true, true],
  ])(
    "with transcript_words %s a guest link shows the Script: %s",
    (words, shown) => {
      const project = minimalProject({
        transcript: {
          utterances: [
            {
              track_id: "t1",
              source_id: "s1",
              speaker: "Maya",
              start: 0,
              end: 0,
              text: "",
              ...(words
                ? {
                    words: [
                      {
                        text: "Welcome",
                        start: 0,
                        end: 0,
                        timeline_start: 1,
                        timeline_end: 2,
                      },
                    ],
                  }
                : {}),
            },
          ],
        },
      });
      project.meta.hydration = { transcript_words: words };
      useDawStore.getState().hydrate("share:abc", project);
      useDawStore.setState({ stage: "review", guestMode: "view" });
      mount(true);
      expect(screen.getByText("guest comments panel")).toBeInTheDocument();
      expect(document.querySelector(".stage-host-guest-script") !== null).toBe(
        shown,
      );
      expect(
        screen.queryByRole("heading", { name: "Nothing to read yet" }) !== null,
      ).toBe(false);
    },
  );

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

  it("leaves the hand-off open, with a Start, while nothing has started", () => {
    asHost("prepare");
    mount();
    expect(screen.getByRole("button", { name: /Edit/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByText("Still getting ready")).toBeNull();
    expect(screen.getAllByText("Not started").length).toBeGreaterThan(0);
  });

  it("offers the hand-off to Edit while it works, quietly, with its reason", () => {
    asHost("prepare");
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({ status: "running" }),
    });
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
  beforeEach(() => {
    server = fakeExportServer();
  });

  it("starts the export and bounce here, and the Share button brings Share into focus without the dialog", async () => {
    asHost("deliver");
    mount();
    const exportButton = await screen.findByRole("button", { name: "Export" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Bounce" }));
    await waitFor(() => expect(server.bounceRequests).toHaveLength(1));
    await userEvent.click(
      screen.getByRole("button", { name: "Share a listen link" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create review link" }),
      ).toHaveFocus(),
    );
    const { chrome } = useDawStore.getState();
    expect([
      chrome.exportRequested,
      chrome.bounceRequested,
      chrome.shareRequested,
    ]).toEqual([false, false, false]);
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
    expect(useDawStore.getState().reviewSection).toBe("queue");
  });

  it("hides the listen link when the share feature is off", () => {
    asHost("deliver");
    render(
      <FeaturesContext.Provider
        value={{ ready: true, manifest: { api_version: 1, features: [] } }}
      >
        <ExportFlowProvider>
          <BounceFlowProvider>
            <ShareFlowProvider>
              <StageHost />
            </ShareFlowProvider>
          </BounceFlowProvider>
        </ExportFlowProvider>
      </FeaturesContext.Provider>,
    );
    expect(
      screen.queryByRole("button", { name: "Share a listen link" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Share" })).toBeNull();
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
