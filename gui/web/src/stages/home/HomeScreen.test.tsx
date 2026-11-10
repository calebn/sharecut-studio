import {
  act,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapJobSnapshot, RecentProject } from "../../api";
import * as api from "../../api";
import { CREATE_LABEL, REPORT_TITLE } from "../../home/HelpDialogView";
import { PHONE_MQ, TABLET_MQ } from "../../hooks/useViewportClass";
import * as ingest from "../../ingest/ingestFiles";
import { ModelsProvider } from "../../models/ModelsProvider";
import { ModelsContext, useModels } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { deferred } from "../../test/deferred";
import {
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../../test/renderWithModels";
import { ApiError } from "../../utils/apiError";
import {
  _resetHomeVisitCountForTests,
  HOME_SCREEN_HINT_DISMISSED_KEY,
  HOME_VISITS_KEY,
} from "../../utils/homeScreenHint";
import { takeAutoRun, takeOpenStage } from "../../utils/openIntent";
import { HomeScreen, SETUP_DISMISSED_KEY } from "./HomeScreen";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  waitForBootstrapJob: vi.fn(),
  cancelBootstrap: vi.fn(),
  runBootstrap: vi.fn(),
  listRecentProjects: vi.fn(),
  forgetRecentProject: vi.fn(),
  revealRecentProject: vi.fn(),
  duplicateRecentProject: vi.fn(),
  createEpisodeProject: vi.fn(),
  addTrackCommand: vi.fn(),
  uploadMediaFile: vi.fn(),
  openEpisodeProject: vi.fn(),
  pickEpisodeProject: vi.fn(),
  fetchDiagnosticsMeta: vi.fn(async () => ({
    report_available: false,
    support_url: null,
    privacy_url: null,
    repository_url: null,
    release_manifest_url: null,
  })),
}));
vi.mock("../../ingest/ingestFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ingest/ingestFiles")>()),
  pickAudioFiles: vi.fn(),
  ingestIntoNewProject: vi.fn(),
}));

const list = vi.mocked(api.listRecentProjects);
const forget = vi.mocked(api.forgetRecentProject);
const reveal = vi.mocked(api.revealRecentProject);
const duplicate = vi.mocked(api.duplicateRecentProject);
const create = vi.mocked(api.createEpisodeProject);
const open = vi.mocked(api.openEpisodeProject);
const pick = vi.mocked(api.pickEpisodeProject);
const pickFiles = vi.mocked(ingest.pickAudioFiles);
const ingestInto = vi.mocked(ingest.ingestIntoNewProject);

const EP = "/ws/rosa/episode.sharecut";

function recent(overrides: Partial<RecentProject> = {}): RecentProject {
  return {
    path: EP,
    name: "Rosa and Maya",
    opened_at: new Date().toISOString(),
    edited_at: new Date().toISOString(),
    duration_sec: 3130,
    stage: "review",
    chip: { text: "Review 6", state: "needs-you" },
    peaks: [],
    folder_missing: false,
    ...overrides,
  };
}

function render(ui: ReactElement, ready = true) {
  return rtlRender(ui, {
    wrapper: modelsWrapper(
      modelsApi({ status: modelStatus(registryRows(), { ready }) }),
    ),
  });
}

async function chooseAppMenuRow(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: "ShareCut app menu" }));
  await user.click(screen.getByRole("menuitem", { name }));
}

describe("HomeScreen", () => {
  const assign = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useDawStore.getState().setCommandPaletteOpen(false);
    useDawStore.getState().setHelpDialogOpen(false);
    useDawStore.getState().setModelsSheetOpen(false);
    useDawStore.getState().setHostMcpDialogOpen(false);
    window.sessionStorage.clear();
    window.localStorage.clear();
    list.mockResolvedValue([recent()]);
    forget.mockResolvedValue(undefined);
    assign.mockReset();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?home=1",
      search: "?home=1",
      assign,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function navigatedTo(): URL {
    expect(assign).toHaveBeenCalledOnce();
    return new URL(String(assign.mock.calls[0]?.[0]));
  }

  it("lists the recent episodes as cards", async () => {
    render(<HomeScreen />);
    const list_ = await screen.findByRole("list", { name: "Recent episodes" });
    const card = within(list_).getByRole("button", { name: /Rosa and Maya/ });
    expect(card).toHaveTextContent("52:10 · edited just now");
    expect(card).toHaveTextContent("Review 6");
  });

  it("shows the empty line when nothing was opened yet", async () => {
    list.mockResolvedValue([]);
    render(<HomeScreen />);
    expect(
      await screen.findByText("Your episodes will appear here."),
    ).toBeInTheDocument();
  });

  it("opens a card on the stage its chip names and drops ?home=1", async () => {
    const user = userEvent.setup();
    open.mockResolvedValue({ project_path: EP, name: "rosa" });
    render(<HomeScreen />);
    await user.click(await screen.findByRole("button", { name: /Rosa/ }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(EP));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const url = navigatedTo();
    expect(url.searchParams.get("project")).toBe(EP);
    expect(url.searchParams.has("home")).toBe(false);
    expect(takeOpenStage(EP)).toBe("review");
  });

  it("says so in plain words when an episode will not open", async () => {
    const user = userEvent.setup();
    open.mockRejectedValue(
      new ApiError("boom /secret/path", "project_open_failed", 400),
    );
    render(<HomeScreen />);
    await user.click(await screen.findByRole("button", { name: /Rosa/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That episode didn't open. Try again.");
    expect(alert).not.toHaveTextContent("secret");
    expect(assign).not.toHaveBeenCalled();
  });

  it("tells the user to rename the old file by hand when Studio could not", async () => {
    const user = userEvent.setup();
    open.mockRejectedValue(
      new ApiError("boom /secret/path", "project_old_filename", 400),
    );
    render(<HomeScreen />);
    await user.click(await screen.findByRole("button", { name: /Rosa/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Studio couldn't update this episode's old file name. In its folder, rename episode.project.json to episode.sharecut, then open it again.",
    );
    expect(alert).not.toHaveTextContent("secret");
    expect(assign).not.toHaveBeenCalled();
  });

  it("says a failed read and reads again on Try again", async () => {
    const user = userEvent.setup();
    list.mockRejectedValueOnce(new Error("500"));
    render(<HomeScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load your episodes.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("list", { name: "Recent episodes" }),
    ).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps typing in the path field when the list arrives late", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?home=1&openOther=1",
      search: "?home=1&openOther=1",
      assign,
    });
    render(<HomeScreen />);
    const field = await screen.findByRole("textbox", {
      name: "Folder of the episode",
    });
    await screen.findByRole("list", { name: "Recent episodes" });
    expect(field).toHaveFocus();
    await user.keyboard("/ws");
    expect(field).toHaveValue("/ws");
  });

  it("shows a card's open failure even when the path field is closed", async () => {
    const user = userEvent.setup();
    pick.mockResolvedValue({ unavailable: true });
    open.mockRejectedValue(new ApiError("x", "project_open_failed", 400));
    render(<HomeScreen />);
    await user.click(
      await screen.findByRole("button", { name: "Open other…" }),
    );
    await screen.findByRole("textbox", { name: "Folder of the episode" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Rosa/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That episode didn't open. Try again.",
    );
  });

  it("says Opening… while a card opens and refuses a second action in words", async () => {
    const user = userEvent.setup();
    let release: (v: { project_path: string; name: string }) => void = () => {};
    open.mockReturnValue(new Promise((resolve) => (release = resolve)));
    render(<HomeScreen />);
    await user.click(await screen.findByRole("button", { name: /Rosa/ }));
    expect(await screen.findByText("Opening…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rosa/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /^Record/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Finish the current step first.",
    );
    expect(create).not.toHaveBeenCalled();
    release({ project_path: EP, name: "rosa" });
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rosa/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("blocks every switch while a recording is armed", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?home=1&sc_close_guard=host",
      search: "?home=1&sc_close_guard=host",
      assign,
    });
    render(<HomeScreen />);
    await user.click(await screen.findByRole("button", { name: /Rosa/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Return to the recording project",
    );
    await user.click(screen.getByRole("button", { name: /^Record/ }));
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  describe("Open other", () => {
    it("opens what the OS picker returns", async () => {
      const user = userEvent.setup();
      pick.mockResolvedValue({ project_path: EP });
      open.mockResolvedValue({ project_path: EP, name: "rosa" });
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: "Open other…" }),
      );
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(open).toHaveBeenCalledWith(EP);
      expect(navigatedTo().searchParams.get("project")).toBe(EP);
    });

    it("shows a cancel detail and stays", async () => {
      const user = userEvent.setup();
      pick.mockResolvedValue({
        cancelled: true,
        detail: "File dialog timed out.",
      });
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: "Open other…" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "File dialog timed out.",
      );
      expect(open).not.toHaveBeenCalled();
    });

    it("falls back to a path field when there is no picker", async () => {
      const user = userEvent.setup();
      pick.mockResolvedValue({ unavailable: true });
      open.mockRejectedValueOnce(
        new ApiError("expected episode.sharecut", "project_path_invalid", 400),
      );
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: "Open other…" }),
      );
      const field = await screen.findByRole("textbox", {
        name: "Folder of the episode",
      });
      await user.type(field, "/ws/nope{Enter}");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "That folder has no ShareCut episode.",
      );
      open.mockResolvedValue({ project_path: EP, name: "rosa" });
      await user.clear(field);
      await user.type(field, `${EP}{Enter}`);
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(open).toHaveBeenLastCalledWith(EP);
    });

    it("opens the path field at once when Studio sent the person here", async () => {
      vi.stubGlobal("location", {
        href: "http://127.0.0.1:8765/?home=1&openOther=1",
        search: "?home=1&openOther=1",
        assign,
      });
      render(<HomeScreen />);
      expect(
        await screen.findByRole("textbox", { name: "Folder of the episode" }),
      ).toBeInTheDocument();
    });
  });

  describe("Find", () => {
    it("opens the picked folder and drops the moved entry", async () => {
      const user = userEvent.setup();
      list.mockResolvedValue([recent({ folder_missing: true })]);
      const moved = "/new/rosa/episode.sharecut";
      pick.mockResolvedValue({ project_path: moved });
      open.mockResolvedValue({ project_path: moved, name: "rosa" });
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /Find/ }));
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(forget).toHaveBeenCalledWith(EP);
      expect(navigatedTo().searchParams.get("project")).toBe(moved);
    });

    it("with no picker, replaces the moved entry once the path field opens the folder", async () => {
      const user = userEvent.setup();
      list.mockResolvedValue([recent({ folder_missing: true })]);
      pick.mockResolvedValue({ unavailable: true });
      const moved = "/new/rosa/episode.sharecut";
      open.mockResolvedValue({ project_path: moved, name: "rosa" });
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /Find/ }));
      const field = await screen.findByRole("textbox", {
        name: "Folder of the episode",
      });
      await user.type(field, `${moved}{Enter}`);
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(forget).toHaveBeenCalledWith(EP);
      expect(navigatedTo().searchParams.get("project")).toBe(moved);
    });

    it("with no picker, forgets nothing once the person closes the path field and opens another folder", async () => {
      const user = userEvent.setup();
      list.mockResolvedValue([recent({ folder_missing: true })]);
      pick.mockResolvedValue({ unavailable: true });
      const other = "/other/maya/episode.sharecut";
      open.mockResolvedValue({ project_path: other, name: "maya" });
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /Find/ }));
      const field = await screen.findByRole("textbox", {
        name: "Folder of the episode",
      });
      await user.type(field, "{Escape}");
      expect(
        screen.queryByRole("textbox", { name: "Folder of the episode" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Open other…" }));
      await user.type(
        await screen.findByRole("textbox", { name: "Folder of the episode" }),
        `${other}{Enter}`,
      );
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(forget).not.toHaveBeenCalled();
    });

    it("forgets nothing when the picker is cancelled and another folder is typed", async () => {
      const user = userEvent.setup();
      vi.stubGlobal("location", {
        href: "http://127.0.0.1:8765/?home=1&openOther=1",
        search: "?home=1&openOther=1",
        assign,
      });
      list.mockResolvedValue([recent({ folder_missing: true })]);
      pick.mockResolvedValue({ cancelled: true });
      const other = "/other/maya/episode.sharecut";
      open.mockResolvedValue({ project_path: other, name: "maya" });
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /Find/ }));
      await waitFor(() => expect(pick).toHaveBeenCalled());
      await user.type(
        await screen.findByRole("textbox", { name: "Folder of the episode" }),
        `${other}{Enter}`,
      );
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(forget).not.toHaveBeenCalled();
    });

    it("keeps the entry when the picker is cancelled", async () => {
      const user = userEvent.setup();
      list.mockResolvedValue([recent({ folder_missing: true })]);
      pick.mockResolvedValue({ cancelled: true });
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /Find/ }));
      await waitFor(() => expect(pick).toHaveBeenCalled());
      expect(forget).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe("the Source tiles", () => {
    it("Record creates an episode in the default folder and opens Record", async () => {
      const user = userEvent.setup();
      create.mockResolvedValue({ project_path: EP, name: "x" });
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /^Record/ }));
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(create).toHaveBeenCalledWith(
        "",
        expect.stringMatching(/^Untitled episode · \d+ \w{3}$/),
      );
      expect(navigatedTo().searchParams.get("project")).toBe(EP);
      expect(takeOpenStage(EP)).toBe("record");
    });

    it("Import uploads the chosen audio, then opens Prepare to process it", async () => {
      const user = userEvent.setup();
      const file = new File(["x"], "Rosa.wav", { type: "audio/wav" });
      pickFiles.mockResolvedValue([file]);
      create.mockResolvedValue({ project_path: EP, name: "Rosa" });
      ingestInto.mockResolvedValue({ added: 1 });
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(create).toHaveBeenCalledWith("", "Rosa");
      expect(ingestInto).toHaveBeenCalledWith(EP, [file]);
      expect(takeOpenStage(EP)).toBe("prepare");
      expect(takeAutoRun(EP)).toBe(true);
    });

    it("Import with nothing chosen does nothing", async () => {
      const user = userEvent.setup();
      pickFiles.mockResolvedValue([]);
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      await waitFor(() => expect(pickFiles).toHaveBeenCalled());
      expect(create).not.toHaveBeenCalled();
    });

    it("a failed first upload says nothing was added and where the folder is", async () => {
      const user = userEvent.setup();
      pickFiles.mockResolvedValue([new File(["x"], "a.wav")]);
      create.mockResolvedValue({ project_path: EP, name: "a" });
      ingestInto.mockResolvedValue({
        added: 0,
        failed: new Error("Disk full."),
      });
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Disk full. Nothing was added. The new episode has no audio yet and is still in Recent. Its folder is /ws/rosa.`,
      );
      expect(forget).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(takeAutoRun(EP)).toBe(false);
    });

    it("a first upload that really fails leaves an empty track and says the episode has no audio", async () => {
      const user = userEvent.setup();
      const real = await vi.importActual<
        typeof import("../../ingest/ingestFiles")
      >("../../ingest/ingestFiles");
      ingestInto.mockImplementationOnce(real.ingestIntoNewProject);
      vi.mocked(api.addTrackCommand).mockResolvedValue({});
      vi.mocked(api.uploadMediaFile).mockRejectedValue(new Error("Disk full."));
      pickFiles.mockResolvedValue([new File(["x"], "a.wav")]);
      create.mockResolvedValue({ project_path: EP, name: "a" });
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Disk full. Nothing was added. The new episode has no audio yet and is still in Recent. Its folder is /ws/rosa.`,
      );
      expect(api.addTrackCommand).toHaveBeenCalledTimes(1);
      expect(assign).not.toHaveBeenCalled();
    });

    it("a later failed upload says how many files were added", async () => {
      const user = userEvent.setup();
      pickFiles.mockResolvedValue([
        new File(["x"], "a.wav"),
        new File(["y"], "b.wav"),
        new File(["z"], "c.wav"),
      ]);
      create.mockResolvedValue({ project_path: EP, name: "Episode, 29 Oct" });
      ingestInto.mockResolvedValue({
        added: 2,
        failed: new Error("Disk full."),
      });
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Disk full. 2 of 3 files were added to "Episode, 29 Oct". Open it from Recent to add the rest. Its folder is /ws/rosa.`,
      );
      expect(forget).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    });

    it("says Starting an episode… while Record creates it", async () => {
      const user = userEvent.setup();
      let release: (v: { project_path: string; name: string }) => void =
        () => {};
      create.mockReturnValue(new Promise((resolve) => (release = resolve)));
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /^Record/ }));
      expect(await screen.findByText("Starting an episode…")).toBeVisible();
      release({ project_path: EP, name: "x" });
      await waitFor(() => expect(assign).toHaveBeenCalled());
    });

    it("ignores a second Record while the page is leaving", async () => {
      const user = userEvent.setup();
      create.mockResolvedValue({ project_path: EP, name: "x" });
      render(<HomeScreen />);
      const record = await screen.findByRole("button", { name: /^Record/ });
      await user.click(record);
      await waitFor(() => expect(assign).toHaveBeenCalledOnce());
      await user.click(record);
      expect(create).toHaveBeenCalledOnce();
      expect(assign).toHaveBeenCalledOnce();
    });

    it("frees Home when the browser restores it from the back-forward cache", async () => {
      const user = userEvent.setup();
      open.mockResolvedValue({ project_path: EP, name: "rosa" });
      create.mockResolvedValue({ project_path: EP, name: "x" });
      render(<HomeScreen />);
      const card = await screen.findByRole("button", { name: /Rosa/ });
      await user.click(card);
      await waitFor(() => expect(assign).toHaveBeenCalledOnce());
      expect(card).toHaveAttribute("aria-busy", "true");
      expect(screen.getByText("Opening…")).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow"));
      });
      expect(card).toHaveAttribute("aria-busy", "true");
      expect(screen.getByText("Opening…")).toBeInTheDocument();
      expect(list).toHaveBeenCalledOnce();

      act(() => {
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        );
      });
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(card).not.toHaveAttribute("aria-busy");
      expect(screen.queryByText("Opening…")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /^Record/ }));
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("lets Record run again after a failed start", async () => {
      const user = userEvent.setup();
      create.mockRejectedValueOnce(new Error("nope"));
      create.mockResolvedValue({ project_path: EP, name: "x" });
      render(<HomeScreen />);
      const record = await screen.findByRole("button", { name: /^Record/ });
      await user.click(record);
      await screen.findByRole("alert");
      await user.click(record);
      await waitFor(() => expect(assign).toHaveBeenCalledOnce());
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("a cancelled Import keeps a visible error", async () => {
      const user = userEvent.setup();
      create.mockRejectedValueOnce(new Error("nope"));
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /^Record/ }));
      await screen.findByRole("alert");
      pickFiles.mockResolvedValue([]);
      await user.click(screen.getByRole("button", { name: /^Import audio/ }));
      await waitFor(() => expect(pickFiles).toHaveBeenCalled());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The episode didn't start.",
      );
    });

    it("names an episode after the day when the file is called con", async () => {
      const user = userEvent.setup();
      pickFiles.mockResolvedValue([
        new File(["x"], "con.wav", { type: "audio/wav" }),
      ]);
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create).toHaveBeenCalledWith(
        "",
        expect.stringMatching(/^Episode, /),
      );
    });

    it("names a reserved Windows name instead of the generic failure", async () => {
      const user = userEvent.setup();
      const file = new File(["x"], "c:on.wav", { type: "audio/wav" });
      pickFiles.mockResolvedValue([file]);
      create.mockRejectedValue(
        new ApiError("server words", "project_name_reserved", 400),
      );
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Windows can't use "c:on" as a folder name. Rename the file and drop it again.`,
      );
      expect(ingestInto).not.toHaveBeenCalled();
    });

    it("says the episode did not start when create fails", async () => {
      const user = userEvent.setup();
      create.mockRejectedValue(new Error("nope"));
      render(<HomeScreen />);
      await user.click(await screen.findByRole("button", { name: /^Record/ }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The episode didn't start.",
      );
    });
  });

  describe("Setup", () => {
    it("shows an adopted Fast job's bytes and cancels that job while Best is selected", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("Unexpected live fetch"))),
      );
      const fast: BootstrapJobSnapshot = {
        id: "home-fast",
        kind: "bootstrap",
        failed_components: [],
        status: "running",
        components: ["whisper"],
        whisper_model: "tiny.en",
        download: {
          component: "whisper",
          bytes: 25_000_000,
          total: 75_000_000,
        },
      };
      vi.mocked(api.fetchBootstrapStatus).mockResolvedValue(
        modelStatus(registryRows()),
      );
      vi.mocked(api.fetchBootstrapJob).mockResolvedValue(fast);
      const done = deferred<BootstrapJobSnapshot>();
      vi.mocked(api.waitForBootstrapJob).mockReturnValue(done.promise);
      vi.mocked(api.cancelBootstrap).mockResolvedValue({
        ...fast,
        status: "cancelled",
      });
      rtlRender(
        <ModelsProvider>
          <HomeScreen />
        </ModelsProvider>,
      );
      expect(await screen.findByText("25 MB of 75 MB")).toBeVisible();
      expect(screen.getByText("Getting ShareCut ready")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
      await waitFor(() =>
        expect(api.cancelBootstrap).toHaveBeenCalledExactlyOnceWith(
          "home-fast",
        ),
      );
      expect(api.runBootstrap).not.toHaveBeenCalled();
      await act(async () => done.resolve({ ...fast, status: "cancelled" }));
      await waitFor(() =>
        expect(screen.queryByText("Getting ShareCut ready")).toBeNull(),
      );
      expect(
        await screen.findByRole("button", { name: "Get ready" }),
      ).toBeVisible();
    });

    it("counts Fast before word timing in the live job order and cancels the exact bundle", async () => {
      const fast: BootstrapJobSnapshot = {
        id: "home-fast-aligner",
        kind: "bootstrap",
        failed_components: [],
        status: "running",
        components: ["whisper", "word-aligner"],
        whisper_model: "tiny.en",
        download: {
          component: "whisper",
          bytes: 25_000_000,
          total: 75_000_000,
        },
      };
      vi.mocked(api.fetchBootstrapStatus).mockImplementation((variant) =>
        Promise.resolve(
          modelStatus(
            registryRows().map((row) =>
              row.id === "whisper" && variant === "tiny.en"
                ? {
                    ...row,
                    model: "tiny.en",
                    size: "75 MB",
                    size_bytes: 75_000_000,
                  }
                : row,
            ),
            { whisper_model: variant ?? "large-v3-turbo" },
          ),
        ),
      );
      vi.mocked(api.fetchBootstrapJob).mockResolvedValue(fast);
      const done = deferred<BootstrapJobSnapshot>();
      let progress: (job: BootstrapJobSnapshot) => void = () => undefined;
      vi.mocked(api.waitForBootstrapJob).mockImplementation((_id, options) => {
        progress = (job) => options?.onUpdate?.(job);
        return done.promise;
      });
      vi.mocked(api.cancelBootstrap).mockResolvedValue({
        ...fast,
        status: "cancelled",
      });
      rtlRender(
        <ModelsProvider>
          <HomeScreen />
        </ModelsProvider>,
      );
      expect(await screen.findByText("25 MB of 435 MB")).toBeVisible();
      act(() =>
        progress({
          ...fast,
          download: {
            component: "whisper",
            bytes: 75_000_000,
            total: 75_000_000,
          },
        }),
      );
      expect(await screen.findByText("75 MB of 435 MB")).toBeVisible();
      act(() =>
        progress({
          ...fast,
          download: {
            component: "word-aligner",
            bytes: 10_000_000,
            total: 360_000_000,
          },
        }),
      );
      expect(await screen.findByText("85 MB of 435 MB")).toBeVisible();
      act(() =>
        progress({
          ...fast,
          download: {
            component: "word-aligner",
            bytes: 20_000_000,
            total: null,
          },
        }),
      );
      expect(await screen.findByText("95 MB downloaded")).toBeVisible();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
      await waitFor(() =>
        expect(api.cancelBootstrap).toHaveBeenCalledExactlyOnceWith(
          "home-fast-aligner",
        ),
      );
      await act(async () => done.resolve({ ...fast, status: "cancelled" }));
      expect(
        await screen.findByRole("button", { name: "Get ready" }),
      ).toBeVisible();
    });

    it.each([
      {
        scenario: "adopting after a failure before bytes",
        sawPartialFast: false,
        total: 360_000_000,
        detail: "10 MB of 360 MB",
      },
      {
        scenario: "observing a failure after partial bytes",
        sawPartialFast: true,
        total: null,
        detail: "10 MB downloaded",
      },
    ])(
      "excludes failed Fast from Setup when $scenario",
      async ({ sawPartialFast, total, detail }) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(() => Promise.reject(new Error("Unexpected live fetch"))),
        );
        const components = ["whisper", "word-aligner"];
        const fast = {
          id: "failed-fast-aligner",
          kind: "bootstrap",
          status: "running",
          components,
          whisper_model: "tiny.en",
          failed_components: [],
          current: 0,
          total: 2,
          failure: null,
          result: null,
          download: {
            component: "whisper",
            bytes: 25_000_000,
            total: 75_000_000,
          },
        };
        const aligner = {
          ...fast,
          failed_components: ["whisper"],
          current: 1,
          download: { component: "word-aligner", bytes: 10_000_000, total },
        };
        vi.mocked(api.fetchBootstrapStatus).mockImplementation((variant) =>
          Promise.resolve(
            modelStatus(
              registryRows().map((row) =>
                row.id === "whisper" && variant === "tiny.en"
                  ? {
                      ...row,
                      model: "tiny.en",
                      size: "75 MB",
                      size_bytes: 75_000_000,
                    }
                  : row,
              ),
              { whisper_model: variant ?? "large-v3-turbo" },
            ),
          ),
        );
        vi.mocked(api.fetchBootstrapJob).mockResolvedValue(
          sawPartialFast ? fast : aligner,
        );
        const done = deferred<BootstrapJobSnapshot>();
        let progress: (job: BootstrapJobSnapshot) => void = () => undefined;
        vi.mocked(api.waitForBootstrapJob).mockImplementation(
          (_id, options) => {
            progress = (job) => options?.onUpdate?.(job);
            return done.promise;
          },
        );
        function SelectedWhisper() {
          const { whisper } = useModels();
          return (
            <output aria-label="Selected Whisper">{whisper.variant}</output>
          );
        }
        rtlRender(
          <ModelsProvider>
            <HomeScreen />
            <SelectedWhisper />
          </ModelsProvider>,
        );
        if (sawPartialFast) {
          expect(await screen.findByText("25 MB of 435 MB")).toBeVisible();
          act(() => progress(aligner));
        }
        expect(await screen.findByText(detail)).toBeVisible();
        expect(screen.getByLabelText("Selected Whisper")).toHaveTextContent(
          "large-v3-turbo",
        );
        if (total === null) {
          expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        } else {
          expect(screen.getByRole("progressbar")).toBeVisible();
        }
      },
    );

    it("offers the bundle, starts the download and remembers Not now", async () => {
      const user = userEvent.setup();
      const models = modelsApi({
        status: modelStatus(registryRows(), { ready: false }),
      });
      rtlRender(
        <ModelsContext.Provider value={models}>
          <HomeScreen />
        </ModelsContext.Provider>,
      );
      await user.click(
        await screen.findByRole("button", { name: "Get ready" }),
      );
      expect(models.download).toHaveBeenCalledWith([
        "whisper",
        "rnnoise",
        "word-aligner",
        "speaker-ecapa",
      ]);
      await user.click(
        screen.getByRole("button", { name: "More about setup" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Not now" }),
      );
      expect(screen.queryByText("Get ShareCut ready")).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(SETUP_DISMISSED_KEY)).toBe("1");
    });

    it("keeps a failed or running download visible after Not now", async () => {
      window.sessionStorage.setItem(SETUP_DISMISSED_KEY, "1");
      const failed = modelsApi({
        status: modelStatus(registryRows(), { ready: false }),
        failures: { "whisper/large-v3-turbo": { kind: "network", plain: "x" } },
      });
      const { unmount } = rtlRender(
        <ModelsContext.Provider value={failed}>
          <HomeScreen />
        </ModelsContext.Provider>,
      );
      expect(
        await screen.findByText("The download didn't finish."),
      ).toBeInTheDocument();
      unmount();
      const base = modelsApi({
        status: modelStatus(registryRows(), { ready: false }),
      });
      const running = {
        ...base,
        models: (base.models ?? []).map((m) =>
          m.id === "whisper"
            ? {
                ...m,
                state: { kind: "downloading" as const, bytes: 1, total: 2 },
              }
            : m,
        ),
      };
      running.downloads = running.models;
      rtlRender(
        <ModelsContext.Provider value={running}>
          <HomeScreen />
        </ModelsContext.Provider>,
      );
      expect(
        await screen.findByText("Getting ShareCut ready"),
      ).toBeInTheDocument();
    });

    it("re-reads the status on Try again after the check gave up, without a download", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const models = {
          ...modelsApi({ status: modelStatus(registryRows()) }),
          models: null,
        };
        rtlRender(
          <ModelsContext.Provider value={models}>
            <HomeScreen />
          </ModelsContext.Provider>,
        );
        await act(() => vi.advanceTimersByTimeAsync(8100));
        await userEvent
          .setup({ advanceTimers: vi.advanceTimersByTime })
          .click(await screen.findByRole("button", { name: "Try again" }));
        expect(models.refresh).toHaveBeenCalledTimes(1);
        expect(models.download).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    describe("with no audio tools", () => {
      const noTools = () =>
        modelsApi({
          status: modelStatus(
            registryRows().map((r) => ({ ...r, state: "installed" as const })),
            {
              ready: false,
              tools: {
                ffmpeg: {
                  state: "missing",
                  source: "not found",
                  hint: "Cannot run 'ffprobe' ... set PODCAST_MCP_FFMPEG",
                },
              },
            },
          ),
        });

      it("shows the card with no download, even after Not now, and never the raw hint", async () => {
        window.sessionStorage.setItem(SETUP_DISMISSED_KEY, "1");
        const models = noTools();
        rtlRender(
          <ModelsContext.Provider value={models}>
            <HomeScreen />
          </ModelsContext.Provider>,
        );
        expect(
          await screen.findByText("Audio tools are missing."),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Get ready" }),
        ).not.toBeInTheDocument();
        expect(document.body).not.toHaveTextContent("PODCAST_MCP_FFMPEG");
        await userEvent.click(
          screen.getByRole("button", { name: "Check again" }),
        );
        expect(models.refresh).toHaveBeenCalled();
        expect(models.download).not.toHaveBeenCalled();
      });

      it("Import and Record say why instead of starting an empty episode", async () => {
        const user = userEvent.setup();
        pickFiles.mockResolvedValue([new File(["x"], "Rosa.wav")]);
        rtlRender(
          <ModelsContext.Provider value={noTools()}>
            <HomeScreen />
          </ModelsContext.Provider>,
        );
        await user.click(
          await screen.findByRole("button", { name: /^Import audio/ }),
        );
        expect(
          await screen.findByText(/Audio tools are missing, so/),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /^Record/ }));
        expect(pickFiles).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
      });
    });

    it("stays away after it was dismissed, and when models are ready", async () => {
      window.sessionStorage.setItem(SETUP_DISMISSED_KEY, "1");
      const { unmount } = render(<HomeScreen />, false);
      await screen.findByRole("list", { name: "Recent episodes" });
      expect(screen.queryByText("Get ShareCut ready")).not.toBeInTheDocument();
      unmount();
      window.sessionStorage.clear();
      render(<HomeScreen />, true);
      await screen.findByRole("list", { name: "Recent episodes" });
      expect(screen.queryByText("Get ShareCut ready")).not.toBeInTheDocument();
    });
  });

  describe("the card menu", () => {
    async function openMenu(user: ReturnType<typeof userEvent.setup>) {
      const card = await screen.findByRole("button", { name: /Rosa/ });
      await user.pointer({ keys: "[MouseRight]", target: card });
      return screen.findByRole("menu", { name: /actions/ });
    }

    it("opens on right-click with Open, Reveal in folder, Duplicate and Remove from list", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      const menu = await openMenu(user);
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Open", "Reveal in folder", "Duplicate", "Remove from list"]);
    });

    it("opens the episode from the menu", async () => {
      const user = userEvent.setup();
      open.mockResolvedValue({ project_path: EP, name: "rosa" });
      render(<HomeScreen />);
      await user.click(
        within(await openMenu(user)).getByRole("menuitem", { name: "Open" }),
      );
      await waitFor(() => expect(open).toHaveBeenCalledWith(EP));
    });

    it("reveals the folder and says so when this computer cannot", async () => {
      const user = userEvent.setup();
      reveal.mockResolvedValueOnce(undefined);
      render(<HomeScreen />);
      await user.click(
        within(await openMenu(user)).getByRole("menuitem", {
          name: "Reveal in folder",
        }),
      );
      expect(reveal).toHaveBeenCalledWith(EP);
      reveal.mockRejectedValueOnce(
        new ApiError("no file manager", "reveal_unavailable", 409),
      );
      await user.click(
        within(await openMenu(user)).getByRole("menuitem", {
          name: "Reveal in folder",
        }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This computer couldn't open its file manager.",
      );
    });

    it("says the folder moved when reveal or duplicate finds no episode", async () => {
      const user = userEvent.setup();
      reveal.mockRejectedValueOnce(
        new ApiError("gone", "project_file_missing", 404),
      );
      duplicate.mockRejectedValueOnce(
        new ApiError("gone", "project_file_missing", 404),
      );
      render(<HomeScreen />);
      for (const name of ["Reveal in folder", "Duplicate"]) {
        await user.click(
          within(await openMenu(user)).getByRole("menuitem", { name }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "That episode's folder has moved.",
        );
      }
    });

    it("keeps Try again for a copy that failed for another reason", async () => {
      const user = userEvent.setup();
      duplicate.mockRejectedValueOnce(
        new ApiError("disk", "project_duplicate_failed", 400),
      );
      render(<HomeScreen />);
      await user.click(
        within(await openMenu(user)).getByRole("menuitem", {
          name: "Duplicate",
        }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "That episode didn't copy. Try again.",
      );
    });

    it("duplicates the episode and reads the list again", async () => {
      const user = userEvent.setup();
      duplicate.mockResolvedValue({
        project_path: "/ws/rosa-copy/episode.sharecut",
        name: "Rosa and Maya copy",
      });
      render(<HomeScreen />);
      await user.click(
        within(await openMenu(user)).getByRole("menuitem", {
          name: "Duplicate",
        }),
      );
      await waitFor(() => expect(duplicate).toHaveBeenCalledWith(EP));
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(assign).not.toHaveBeenCalled();
    });

    it("removes the card from the list without touching the episode", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await user.click(
        within(await openMenu(user)).getByRole("menuitem", {
          name: "Remove from list",
        }),
      );
      expect(forget).toHaveBeenCalledWith(EP);
      expect(
        await screen.findByText("Your episodes will appear here."),
      ).toBeInTheDocument();
      expect(open).not.toHaveBeenCalled();
    });
  });

  describe("the Home keys", () => {
    it("runs Import on Mod+I and Record on R", async () => {
      const user = userEvent.setup();
      pickFiles.mockResolvedValue([]);
      create.mockResolvedValue({ project_path: EP, name: "Untitled" });
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await user.keyboard("{Control>}i{/Control}");
      await waitFor(() => expect(pickFiles).toHaveBeenCalledOnce());
      await user.keyboard("r");
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
    });

    it("opens Open other on Mod+O and Help on ?", async () => {
      const user = userEvent.setup();
      pick.mockResolvedValue({ cancelled: true });
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await user.keyboard("{Control>}o{/Control}");
      await waitFor(() => expect(pick).toHaveBeenCalledOnce());
      await user.keyboard("?");
      expect(
        await screen.findByRole("dialog", { name: "Commands and shortcuts" }),
      ).toBeInTheDocument();
    });

    it("leaves the keys to a field", async () => {
      const user = userEvent.setup();
      vi.stubGlobal("location", {
        href: "http://127.0.0.1:8765/?home=1&openOther=1",
        search: "?home=1&openOther=1",
        assign,
      });
      render(<HomeScreen />);
      const field = await screen.findByRole("textbox", {
        name: "Folder of the episode",
      });
      await user.click(field);
      await user.keyboard("r?");
      expect(field).toHaveValue("r?");
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("the Add to Home Screen card", () => {
    beforeEach(() => {
      for (const [key, value] of Object.entries({
        standalone: false,
        maxTouchPoints: 5,
      }))
        Object.defineProperty(navigator, key, {
          value,
          configurable: true,
        });
      vi.stubGlobal(
        "matchMedia",
        (query: string) =>
          ({
            media: query,
            matches: query === "(display-mode: browser)",
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      );
      _resetHomeVisitCountForTests();
    });

    it("stays away on the first visit and shows on the second", async () => {
      const first = render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      expect(
        screen.queryByText("Add to Home Screen for full screen."),
      ).toBeNull();
      first.unmount();
      _resetHomeVisitCountForTests();
      render(<HomeScreen />);
      expect(
        await screen.findByText("Add to Home Screen for full screen."),
      ).toBeInTheDocument();
    });

    it("is dismissed for this device with its close button", async () => {
      const user = userEvent.setup();
      window.localStorage.setItem(HOME_VISITS_KEY, "3");
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", {
          name: "Dismiss: Add to Home Screen hint",
        }),
      );
      expect(
        screen.queryByText("Add to Home Screen for full screen."),
      ).toBeNull();
      expect(window.localStorage.getItem(HOME_SCREEN_HINT_DISMISSED_KEY)).toBe(
        "1",
      );
    });
  });

  describe("command palette on Home", () => {
    it("opens on ? with the Help group first and only the commands that fit Home", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await user.keyboard("?");
      const palette = await screen.findByRole("dialog", {
        name: "Commands and shortcuts",
      });
      const options = within(palette)
        .getAllByRole("option")
        .map((option) => option.textContent ?? "");
      expect(options[0]).toContain("Report a problem");
      expect(options.some((text) => text.includes("Guides"))).toBe(true);
      expect(options.some((text) => text.includes("Gestures"))).toBe(false);
      expect(
        within(palette).queryByRole("group", { name: "Gestures" }),
      ).toBeNull();
      expect(options.some((text) => text.includes("Manage models"))).toBe(true);
      expect(options.some((text) => text.includes("Connect agent"))).toBe(true);
      expect(options.some((text) => text.includes("Play / pause"))).toBe(false);
      expect(options.some((text) => text.includes("Go to Edit"))).toBe(false);
      const first = within(palette).getAllByRole("option")[0];
      expect(
        within(palette).getByRole("combobox", { name: "Search commands" }),
      ).toHaveAttribute("aria-activedescendant", first.id);
    });

    it("publishes the shell, so a dialog on Home rises as a sheet on a phone", async () => {
      vi.stubGlobal(
        "matchMedia",
        (query: string) =>
          ({
            media: query,
            matches: query === PHONE_MQ || query === TABLET_MQ,
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      );
      try {
        const user = userEvent.setup();
        const { unmount } = render(<HomeScreen />);
        await screen.findByRole("list", { name: "Recent episodes" });
        expect(document.documentElement.dataset.shell).toBe("phone");
        await chooseAppMenuRow(user, "Help");
        const sheet = await screen.findByRole("dialog", { name: "Help" });
        expect(sheet).toHaveAttribute("aria-modal", "true");
        expect(sheet).toHaveClass("command-palette-root");
        expect(sheet.querySelector(".help-sheet-panel")).not.toBeNull();
        unmount();
        expect(document.documentElement.dataset.shell).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("has no Help or More button: the wordmark is the app menu", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      expect(screen.queryByRole("button", { name: /^Help/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "More" })).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "ShareCut app menu" }),
      );
      expect(
        within(screen.getByRole("menu", { name: "App menu" }))
          .getAllByRole("menuitem")
          .map((row) => row.textContent),
      ).toEqual(["Settings", "Connect agent", "Help"]);
    });

    it("opens Models from the app menu's Settings row and Connect agent from its row", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await chooseAppMenuRow(user, "Settings");
      expect(useDawStore.getState().chrome.modelsSheetOpen).toBe(true);
      useDawStore.getState().setModelsSheetOpen(false);
      await chooseAppMenuRow(user, "Connect agent");
      expect(useDawStore.getState().chrome.hostMcpDialogOpen).toBe(true);
      useDawStore.getState().setHostMcpDialogOpen(false);
    });

    it("opens the Help popover under the app menu with three rows and restores focus on close", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await chooseAppMenuRow(user, "Help");
      const sheet = await screen.findByRole("dialog", { name: "Help" });
      expect(sheet).toHaveAttribute("aria-modal", "false");
      expect(
        within(within(sheet).getByRole("list", { name: "Help" }))
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Shortcuts and gestures", "Report a problem", "Guides"]);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "ShareCut app menu" }),
      ).toHaveFocus();
    });

    it("names the app menu button for what it opens", async () => {
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      expect(
        screen.getByRole("button", { name: "ShareCut app menu" }),
      ).toHaveAttribute("aria-haspopup");
    });

    it("lines the Help popover's left edge up with the app menu button", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      const trigger = screen.getByRole("button", { name: "ShareCut app menu" });
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        x: 120,
        y: 16,
        left: 120,
        top: 16,
        right: 331,
        bottom: 48,
        width: 211,
        height: 32,
        toJSON: () => ({}),
      });
      await chooseAppMenuRow(user, "Help");
      const sheet = await screen.findByRole("dialog", { name: "Help" });
      expect(sheet).toHaveAttribute("aria-modal", "false");
      await waitFor(() =>
        expect(sheet.closest<HTMLElement>(".help-sheet-panel")).toHaveStyle({
          left: "120px",
        }),
      );
    });

    it("focuses the first Help row when it opens from the app menu", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await chooseAppMenuRow(user, "Help");
      await screen.findByRole("dialog", { name: "Help" });
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Shortcuts and gestures/ }),
        ).toHaveFocus(),
      );
    });

    it("falls back to a modal sheet when the app menu button is not there", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      screen
        .getByRole("button", { name: "ShareCut app menu" })
        .removeAttribute("data-app-menu");
      await chooseAppMenuRow(user, "Help");
      expect(
        await screen.findByRole("dialog", { name: "Help" }),
      ).toHaveAttribute("aria-modal", "true");
    });

    it("falls back to a modal sheet on a tablet viewport", async () => {
      vi.stubGlobal(
        "matchMedia",
        (query: string) =>
          ({
            media: query,
            matches: query === TABLET_MQ,
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      );
      try {
        const user = userEvent.setup();
        render(<HomeScreen />);
        await screen.findByRole("list", { name: "Recent episodes" });
        await chooseAppMenuRow(user, "Help");
        expect(
          await screen.findByRole("dialog", { name: "Help" }),
        ).toHaveAttribute("aria-modal", "true");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("opens the palette from the Shortcuts and gestures row and returns focus to the app menu", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      const trigger = screen.getByRole("button", { name: "ShareCut app menu" });
      await chooseAppMenuRow(user, "Help");
      await user.click(
        await screen.findByRole("button", { name: /Shortcuts and gestures/ }),
      );
      const palette = await screen.findByRole("dialog", {
        name: "Commands and shortcuts",
      });
      expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
      const search = within(palette).getByRole("combobox", {
        name: "Search commands",
      });
      await waitFor(() => expect(search).toHaveFocus());
      await user.keyboard("{Escape}");
      await waitFor(() => expect(trigger).toHaveFocus());
    });

    it("opens the palette, not the Help sheet, on ?", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await user.keyboard("?");
      await screen.findByRole("dialog", { name: "Commands and shortcuts" });
      expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
    });

    it("steps into Report a problem inside the Help sheet and back", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await chooseAppMenuRow(user, "Help");
      await user.click(
        await screen.findByRole("button", { name: /Report a problem/ }),
      );
      const report = await screen.findByRole("dialog", {
        name: REPORT_TITLE,
      });
      expect(
        within(report).getByRole("button", {
          name: CREATE_LABEL,
        }),
      ).toBeInTheDocument();
      await user.click(within(report).getByRole("button", { name: "Back" }));
      expect(
        await screen.findByRole("dialog", { name: "Help" }),
      ).toBeInTheDocument();
    });

    it("opens the guides from the Guides row", async () => {
      const user = userEvent.setup();
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await chooseAppMenuRow(user, "Help");
      await user.click(await screen.findByRole("button", { name: /Guides/ }));
      expect(open).toHaveBeenCalledWith(
        "https://docs.sharecut.studio/",
        "_blank",
        "noopener,noreferrer",
      );
      open.mockRestore();
    });

    it("opens Report a problem… from the palette Help group straight on the report step", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await user.keyboard("?");
      await user.click(
        await screen.findByRole("option", { name: /Report a problem/ }),
      );
      expect(
        await screen.findByRole("dialog", { name: REPORT_TITLE }),
      ).toBeInTheDocument();
    });

    it("opens the guides in a new tab from the Help group", async () => {
      const user = userEvent.setup();
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await user.keyboard("?");
      await user.click(await screen.findByRole("option", { name: /Guides/ }));
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith(
          "https://docs.sharecut.studio/",
          "_blank",
          "noopener,noreferrer",
        ),
      );
      open.mockRestore();
    });

    it("opens Models and Connect agent from the palette", async () => {
      const user = userEvent.setup();
      render(<HomeScreen />);
      await screen.findByRole("list", { name: "Recent episodes" });
      await user.keyboard("?");
      await user.click(
        await screen.findByRole("option", { name: /Manage models/ }),
      );
      await waitFor(() =>
        expect(useDawStore.getState().chrome.modelsSheetOpen).toBe(true),
      );
      useDawStore.getState().setModelsSheetOpen(false);
      await user.keyboard("?");
      await user.click(
        await screen.findByRole("option", { name: /Connect agent/ }),
      );
      await waitFor(() =>
        expect(useDawStore.getState().chrome.hostMcpDialogOpen).toBe(true),
      );
    });
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<HomeScreen />);
    await screen.findByRole("list", { name: "Recent episodes" });
    await expectNoA11yViolations(container);
  });
});
