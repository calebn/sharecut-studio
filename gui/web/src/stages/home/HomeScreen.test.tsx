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
import type { RecentProject } from "../../api";
import * as api from "../../api";
import * as ingest from "../../ingest/ingestFiles";
import { ModelsContext } from "../../models/useModels";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../../test/renderWithModels";
import { ApiError } from "../../utils/apiError";
import { takeAutoRun, takeOpenStage } from "../../utils/openIntent";
import { HomeScreen, SETUP_DISMISSED_KEY } from "./HomeScreen";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listRecentProjects: vi.fn(),
  forgetRecentProject: vi.fn(),
  createEpisodeProject: vi.fn(),
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
const create = vi.mocked(api.createEpisodeProject);
const open = vi.mocked(api.openEpisodeProject);
const pick = vi.mocked(api.pickEpisodeProject);
const pickFiles = vi.mocked(ingest.pickAudioFiles);
const ingestInto = vi.mocked(ingest.ingestIntoNewProject);

const EP = "/ws/rosa/episode.project.json";

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

describe("HomeScreen", () => {
  const assign = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
        new ApiError(
          "expected episode.project.json",
          "project_path_invalid",
          400,
        ),
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
      const moved = "/new/rosa/episode.project.json";
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
      const moved = "/new/rosa/episode.project.json";
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
      const other = "/other/maya/episode.project.json";
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
      ingestInto.mockResolvedValue(undefined);
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

    it("a failed upload stays on Home and points to Recent", async () => {
      const user = userEvent.setup();
      pickFiles.mockResolvedValue([new File(["x"], "a.wav")]);
      create.mockResolvedValue({ project_path: EP, name: "a" });
      ingestInto.mockRejectedValue(new Error("Disk full."));
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Disk full. The episode was started: open it from Recent.",
      );
      expect(assign).not.toHaveBeenCalled();
      expect(takeAutoRun(EP)).toBe(false);
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

    it("names a reserved Windows name instead of the generic failure", async () => {
      const user = userEvent.setup();
      const file = new File(["x"], "con.wav", { type: "audio/wav" });
      pickFiles.mockResolvedValue([file]);
      create.mockRejectedValue(
        new ApiError("server words", "project_name_reserved", 400),
      );
      render(<HomeScreen />);
      await user.click(
        await screen.findByRole("button", { name: /^Import audio/ }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Windows can't use "con" as a folder name. Choose another episode name.`,
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
      expect(models.download).toHaveBeenCalledWith(["whisper", "rnnoise"]);
      await user.click(
        screen.getByRole("button", { name: "More about setup" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Not now" }),
      );
      expect(screen.queryByText("Get ShareCut ready")).not.toBeInTheDocument();
      expect(window.localStorage.getItem(SETUP_DISMISSED_KEY)).toBe("1");
    });

    it("keeps a failed or running download visible after Not now", async () => {
      window.localStorage.setItem(SETUP_DISMISSED_KEY, "1");
      const failed = modelsApi({
        status: modelStatus(registryRows(), { ready: false }),
        failures: { whisper: { kind: "network", plain: "x" } },
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
      rtlRender(
        <ModelsContext.Provider value={running}>
          <HomeScreen />
        </ModelsContext.Provider>,
      );
      expect(
        await screen.findByText("Getting ShareCut ready"),
      ).toBeInTheDocument();
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
        window.localStorage.setItem(SETUP_DISMISSED_KEY, "1");
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
      window.localStorage.setItem(SETUP_DISMISSED_KEY, "1");
      const { unmount } = render(<HomeScreen />, false);
      await screen.findByRole("list", { name: "Recent episodes" });
      expect(screen.queryByText("Get ShareCut ready")).not.toBeInTheDocument();
      unmount();
      window.localStorage.clear();
      render(<HomeScreen />, true);
      await screen.findByRole("list", { name: "Recent episodes" });
      expect(screen.queryByText("Get ShareCut ready")).not.toBeInTheDocument();
    });
  });

  it("makes home content inert while Help is open and restores it on close", async () => {
    const user = userEvent.setup();
    const { container } = render(<HomeScreen />);
    await screen.findByRole("list", { name: "Recent episodes" });
    const content = container.querySelector<HTMLElement>(
      "[data-daw-app-chrome]",
    );
    expect(content).toBeTruthy();
    const trigger = screen.getByRole("button", { name: /^Help$/ });
    await user.click(trigger);
    expect(content?.inert).toBe(true);
    await user.keyboard("{Escape}");
    expect(content?.inert).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<HomeScreen />);
    await screen.findByRole("list", { name: "Recent episodes" });
    await expectNoA11yViolations(container);
  });
});
