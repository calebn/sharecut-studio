import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startExportJob } from "../../api";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { FeaturesContext } from "../../extensions/FeaturesContext";
import { FEATURE_SHARE_UI_MENU } from "../../extensions/features";
import { useRecordHostStore } from "../../record/hostStore";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { StageId } from "../../types/stage";
import { BounceFlowProvider } from "./bounceFlow";
import { ExportFlowProvider } from "./exportFlow";
import { StageHost } from "./StageHost";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  loadPipelineConfig: vi.fn(async () => ({
    config: { export: { wav: true, formats: [{ ext: "mp3" }] } },
  })),
  startExportJob: vi.fn(),
  followJobToOk: vi.fn(() => new Promise(() => undefined)),
  listHostShares: vi.fn(async () => ({ shares: [], public_origin: "" })),
}));
vi.mock("../../panels/PipelinePanel", () => ({
  PipelinePanel: () => <div>pipeline panel</div>,
}));
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
          <StageHost guestShare={guestShare} />
        </BounceFlowProvider>
      </ExportFlowProvider>
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
        screen.queryByRole("button", { name: /Open the room/ }),
      ).toBeNull();
      expect(screen.queryByText("pipeline panel")).toBeNull();
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
      ["record", "No take yet"],
      ["prepare", "Getting ready"],
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
  it("shows the import entry points and the pipeline", () => {
    asHost("prepare");
    mount();
    expect(
      screen.getByRole("button", { name: /Add audio/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Record another session" }),
    ).toBeInTheDocument();
    expect(screen.getByText("pipeline panel")).toBeInTheDocument();
  });

  it("goes to Record from the record entry point", async () => {
    asHost("prepare");
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Record another session" }),
    );
    expect(useDawStore.getState().stage).toBe("record");
  });

  it("hands off to Edit when nothing waits", async () => {
    asHost("prepare");
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(useDawStore.getState().stage).toBe("edit");
  });

  it("shows only the drop target and sources for a project with no tracks", () => {
    asHost("prepare", []);
    mount();
    expect(
      screen.getByRole("button", { name: /Drop audio files here/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("pipeline panel")).toBeNull();
  });

  it("keeps a skeleton while the project loads", () => {
    asHost("prepare");
    useDawStore.setState({ project: null });
    const { container } = mount();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("pipeline panel")).toBeNull();
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
  it("starts the export through its command", async () => {
    asHost("deliver");
    mount();
    const exportButton = await screen.findByRole("button", { name: "Export" });
    await waitFor(() => expect(exportButton).toBeEnabled());
    await userEvent.click(exportButton);
    await waitFor(() => expect(startExportJob).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(useDawStore.getState().chrome.exportRequested).toBe(false),
    );
  });

  it("lists the share links on Deliver, and Share goes there and focuses Create review link", async () => {
    asHost("edit");
    mount();
    await act(async () => {
      await execute("share.manage");
    });
    expect(useDawStore.getState().stage).toBe("deliver");
    const create = await screen.findByRole("button", {
      name: "Create review link",
    });
    await waitFor(() => expect(create).toHaveFocus());
    expect(useDawStore.getState().chrome.shareRequested).toBe(false);
    expect(await screen.findByText("No review links yet.")).toBeInTheDocument();
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
    expect(screen.getByText("Suggestions decided")).toBeInTheDocument();
    expect(screen.getByText("0 of 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(useDawStore.getState().stage).toBe("review");
    expect(useDawStore.getState().reviewSection).toBe("impact");
  });

  it("hides Share when the share feature is off", () => {
    asHost("deliver");
    render(
      <FeaturesContext.Provider
        value={{ ready: true, manifest: { api_version: 1, features: [] } }}
      >
        <ExportFlowProvider>
          <BounceFlowProvider>
            <StageHost />
          </BounceFlowProvider>
        </ExportFlowProvider>
      </FeaturesContext.Provider>,
    );
    expect(screen.queryByRole("region", { name: "Share" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Create review link" }),
    ).toBeNull();
  });
});

describe("Record host", () => {
  it("opens the room dialog and leaves it mounted elsewhere", async () => {
    asHost("record");
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Open the room" }),
    );
    expect(useDawStore.getState().chrome.recordPanelOpen).toBe(true);
  });

  it("shows the live take and how to get back to it", () => {
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
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to the room" }),
    ).toBeInTheDocument();
  });
});
