import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  moveProject,
  pickFolder,
  revealProject,
  setJoinFadeLimitCommand,
} from "../api";
import { registerHostCommands } from "../commands/host";
import { __resetThemeForTests, useTheme } from "../hooks/useTheme";
import { ModelsSheet } from "../models";
import { ModelsContext } from "../models/useModels";
import { loadHostCommandCount } from "../services/offlineQueue/offlineStore";
import { CommandPalette } from "../stage/dialogs/CommandPalette";
import { withCommandSendOwnership } from "../state/commandSendOwnership";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { AppHeader } from "../system/AppHeader";
import { expectNoA11yViolations } from "../test/a11y";
import { setChrome } from "../test/chrome";
import { deferred } from "../test/deferred";
import { waitForDialogFocus } from "../test/dialogFocus";
import { minimalProject } from "../test/fixtures";
import { modelStatus, modelsApi, registryRows } from "../test/renderWithModels";
import { ApiError } from "../utils/apiError";
import { OPEN_SETTINGS_EVENT, SettingsHost } from "./SettingsHost";

const tauri = vi.hoisted(() => ({ on: false }));
const queued = vi.hoisted(() => ({ count: 0 }));
vi.mock("../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandCount: vi.fn(async () => queued.count),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.on }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  revealProject: vi.fn(),
  pickFolder: vi.fn(),
  moveProject: vi.fn(),
  setJoinFadeLimitCommand: vi.fn(async () => ({})),
  listRecentProjects: vi.fn(async () => []),
}));

const PROJECT_PATH = "/Users/ada/Episodes/ep-12/episode.sharecut";

function Harness() {
  const modelsOpen = useDaw((s) => s.chrome.modelsSheetOpen);
  return (
    <ModelsContext.Provider
      value={modelsApi({ status: modelStatus(registryRows()) })}
    >
      <button type="button" data-app-menu>
        App menu
      </button>
      <SettingsHost />
      <ModelsSheet
        open={modelsOpen}
        onClose={() => useDawStore.getState().setModelsSheetOpen(false)}
      />
      <CommandPalette />
    </ModelsContext.Provider>
  );
}

async function openSettings() {
  act(() => useDawStore.getState().setSettingsSheetOpen(true));
  const sheet = await screen.findByRole("dialog", { name: "Settings" });
  await waitForDialogFocus(sheet);
  return sheet;
}

function inProject(projectPath = PROJECT_PATH) {
  useDawStore.getState().hydrate(projectPath, minimalProject());
}

beforeEach(() => {
  tauri.on = false;
  vi.mocked(revealProject).mockReset();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  __resetThemeForTests();
  useDawStore.setState({ project: null, projectPath: "" });
  setChrome({
    settingsSheetOpen: false,
    modelsSheetOpen: false,
    commandPaletteOpen: false,
  });
});

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  __resetThemeForTests();
});

const rowNames = (sheet: HTMLElement) =>
  within(sheet)
    .getAllByRole("heading", { level: 3 })
    .map((h) => h.textContent)
    .concat(
      within(sheet)
        .getAllByRole("button")
        .map((b) => b.textContent ?? "")
        .filter((t) => t === "Models" || t === "Keyboard shortcuts"),
    );

describe("SettingsHost rows", () => {
  it("in a project lists Appearance, Saved in, the join fade limit, Models and Keyboard shortcuts", async () => {
    inProject();
    render(<Harness />);
    const sheet = await openSettings();
    expect(rowNames(sheet)).toEqual([
      "Appearance",
      "Saved in",
      "Longest automatic join fade",
      "Models",
      "Keyboard shortcuts",
    ]);
    expect(
      within(sheet).getByText("/Users/ada/Episodes/ep-12"),
    ).toHaveAttribute("title", "/Users/ada/Episodes/ep-12");
    await expectNoA11yViolations(sheet);
  });

  it("on Home lists only Appearance and Models", async () => {
    render(<Harness />);
    const sheet = await openSettings();
    expect(rowNames(sheet)).toEqual(["Appearance", "Models"]);
  });
});

describe("Longest automatic join fade", () => {
  const LABEL = "Longest automatic join fade";
  const withLimit = (ms: number, defaultMs = 40) => {
    const project = minimalProject();
    useDawStore.getState().hydrate(PROJECT_PATH, {
      ...project,
      clips: {
        ...project.clips,
        join_fade_limit_ms: ms,
        join_fade_limit_default_ms: defaultMs,
      },
    });
  };
  const field = (sheet: HTMLElement) =>
    within(sheet).getByRole("spinbutton", { name: LABEL });
  const typeMs = async (sheet: HTMLElement, text: string) => {
    fireEvent.keyDown(field(sheet), { key: "Enter" });
    const input = within(sheet).getByRole("textbox", { name: LABEL });
    fireEvent.change(input, { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
  };

  beforeEach(() => {
    vi.mocked(setJoinFadeLimitCommand).mockReset().mockResolvedValue({});
  });

  it("shows the limit in force, 0 to 200 ms, and says it limits only automatic fades", async () => {
    withLimit(40);
    render(<Harness />);
    const sheet = await openSettings();
    expect(field(sheet)).toHaveAttribute("aria-valuenow", "40");
    expect(field(sheet)).toHaveAttribute("aria-valuemin", "0");
    expect(field(sheet)).toHaveAttribute("aria-valuemax", "200");
    expect(field(sheet)).toHaveAccessibleDescription(
      "ShareCut picks each automatic join fade up to this length. Fades you set yourself are not limited.",
    );
    await expectNoA11yViolations(sheet);
  });

  it("saves a typed limit for the episode", async () => {
    withLimit(40);
    render(<Harness />);
    const sheet = await openSettings();
    await typeMs(sheet, "120");
    expect(setJoinFadeLimitCommand).toHaveBeenCalledOnce();
    expect(setJoinFadeLimitCommand).toHaveBeenCalledWith(PROJECT_PATH, 120);
  });

  it("keeps showing the saved limit until the episode's clips catch up", async () => {
    withLimit(40);
    render(<Harness />);
    const sheet = await openSettings();
    await typeMs(sheet, "120");
    expect(field(sheet)).toHaveAttribute("aria-valuenow", "120");
    act(() => withLimit(120));
    expect(field(sheet)).toHaveAttribute("aria-valuenow", "120");
  });

  it("steps by 5 ms with the arrow keys", async () => {
    withLimit(40);
    render(<Harness />);
    const sheet = await openSettings();
    await act(async () => {
      fireEvent.keyDown(field(sheet), { key: "ArrowUp" });
    });
    expect(setJoinFadeLimitCommand).toHaveBeenCalledWith(PROJECT_PATH, 45);
  });

  it("goes back to the app default from the reset dot, storing nothing", async () => {
    withLimit(120, 60);
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(
      within(sheet).getByRole("button", { name: `Reset ${LABEL} to 60 ms` }),
    );
    expect(setJoinFadeLimitCommand).toHaveBeenCalledWith(PROJECT_PATH, null);
  });

  it("refuses a limit over 200 ms without saving", async () => {
    withLimit(40);
    render(<Harness />);
    const sheet = await openSettings();
    await typeMs(sheet, "250");
    expect(setJoinFadeLimitCommand).not.toHaveBeenCalled();
  });

  it("shows the server's refusal under the row", async () => {
    withLimit(40);
    vi.mocked(setJoinFadeLimitCommand).mockRejectedValue(
      new ApiError(
        "Longest automatic join fade must be between 0 and 200 ms.",
        "out_of_range",
        400,
      ),
    );
    render(<Harness />);
    const sheet = await openSettings();
    await typeMs(sheet, "120");
    expect(
      await within(sheet).findByText(/must be between 0 and 200 ms/),
    ).toBeVisible();
    expect(field(sheet)).toHaveAttribute("aria-valuenow", "40");
  });

  it("is read-only, with the reason, for a link that can only view", async () => {
    withLimit(40);
    useDawStore.setState({
      projectPath: "share:ep",
      guestMode: "viewer",
      shareCapabilities: ["view"],
    });
    render(<Harness />);
    const sheet = await openSettings();
    expect(field(sheet)).toHaveAttribute("aria-readonly", "true");
    expect(within(sheet).getByText(/can view, but not change/)).toBeVisible();
    await act(async () => {
      fireEvent.keyDown(field(sheet), { key: "ArrowUp" });
    });
    expect(setJoinFadeLimitCommand).not.toHaveBeenCalled();
  });

  it("is absent on Home", async () => {
    render(<Harness />);
    const sheet = await openSettings();
    expect(within(sheet).queryByRole("spinbutton", { name: LABEL })).toBeNull();
  });
});

describe("Reveal in folder", () => {
  it("is absent outside the desktop app", async () => {
    inProject();
    render(<Harness />);
    const sheet = await openSettings();
    expect(
      within(sheet).queryByRole("button", { name: "Reveal in folder" }),
    ).toBeNull();
  });

  it("reveals the project file in the desktop app", async () => {
    tauri.on = true;
    inProject();
    vi.mocked(revealProject).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(
      within(sheet).getByRole("button", { name: "Reveal in folder" }),
    );
    expect(revealProject).toHaveBeenCalledWith(PROJECT_PATH);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  it("keeps Move disabled and marks only Reveal busy while revealing", async () => {
    tauri.on = true;
    inProject();
    const pending = deferred<void>();
    vi.mocked(revealProject).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    const move = within(sheet).getByRole("button", { name: "Move…" });
    const reveal = within(sheet).getByRole("button", {
      name: "Reveal in folder",
    });

    await user.click(reveal);
    expect(reveal).toHaveAccessibleName("Revealing…");
    expect(reveal).toHaveAttribute("aria-busy", "true");
    expect(move).toBeDisabled();
    expect(move).not.toHaveAttribute("aria-busy");
    await user.click(move);
    expect(pickFolder).not.toHaveBeenCalled();

    await act(async () => pending.resolve(undefined));
    expect(reveal).toHaveAccessibleName("Reveal in folder");
    expect(reveal).not.toHaveAttribute("aria-busy");
    expect(move).toBeEnabled();
  });

  it("shows the server's refusal under Saved in and keeps the sheet open", async () => {
    tauri.on = true;
    inProject();
    vi.mocked(revealProject).mockRejectedValue(
      new ApiError(
        "This computer couldn't open its file manager.",
        "reveal_unavailable",
        409,
      ),
    );
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    const button = within(sheet).getByRole("button", {
      name: "Reveal in folder",
    });
    await user.click(button);
    expect(
      await within(sheet).findByText(
        "This computer couldn't open its file manager.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await waitFor(() => expect(button).toHaveFocus());
  });
});

describe("Move…", () => {
  const assign = vi.fn();
  let episode = 0;
  let projectPath: string;
  beforeEach(() => {
    projectPath = `/Users/ada/Episodes/move-test-${++episode}/episode.sharecut`;
    queued.count = 0;
    assign.mockReset();
    vi.stubGlobal("location", {
      href: `http://127.0.0.1:8765/?project=${encodeURIComponent(projectPath)}`,
      assign,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is absent outside the desktop app", async () => {
    inProject(projectPath);
    render(<Harness />);
    const sheet = await openSettings();
    expect(within(sheet).queryByRole("button", { name: "Move…" })).toBeNull();
  });

  it("moves the episode to the picked folder and reloads at the new path", async () => {
    tauri.on = true;
    inProject(projectPath);
    useDawStore.setState({ localClientId: "tab-1" });
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
    vi.mocked(moveProject).mockResolvedValue({
      project_path: "/Users/ada/Archive/ep-12/episode.sharecut",
      previous_path: projectPath,
    });
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(moveProject).toHaveBeenCalledWith(
      projectPath,
      "/Users/ada/Archive",
      "tab-1",
    );
    expect(String(assign.mock.calls[0]?.[0])).toContain(
      encodeURIComponent("/Users/ada/Archive/ep-12/episode.sharecut"),
    );
  });

  it("refuses to open the folder picker when the recording close guard is armed", async () => {
    tauri.on = true;
    inProject(projectPath);
    window.location.href += "&sc_close_guard=host";
    vi.mocked(pickFolder).mockResolvedValue({ cancelled: true });
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();

    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    expect(
      await within(sheet).findByText(
        "Stop the recording room before moving this episode.",
      ),
    ).toBeVisible();
    expect(pickFolder).not.toHaveBeenCalled();
    expect(moveProject).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("releases the move fence when a recording starts while the picker is open", async () => {
    tauri.on = true;
    inProject(projectPath);
    const picked = deferred<Awaited<ReturnType<typeof pickFolder>>>();
    vi.mocked(pickFolder).mockReturnValueOnce(picked.promise);
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    const button = within(sheet).getByRole("button", { name: "Move…" });

    await user.click(button);
    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    window.location.href += "&sc_close_guard=host";
    await act(async () => picked.resolve({ folder: "/Users/ada/Archive" }));
    expect(
      await within(sheet).findByText(
        "Stop the recording room before moving this episode.",
      ),
    ).toBeVisible();
    expect(moveProject).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    await expect(
      withCommandSendOwnership(projectPath, "shared", async () => "saved"),
    ).resolves.toBe("saved");

    window.location.href = window.location.href.replace(
      "&sc_close_guard=host",
      "",
    );
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
    vi.mocked(moveProject).mockResolvedValue({
      project_path: "/Users/ada/Archive/ep-12/episode.sharecut",
      previous_path: projectPath,
    });
    await user.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
  });

  it("changes nothing when the folder dialog is cancelled", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(pickFolder).mockResolvedValue({ cancelled: true });
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    const button = within(sheet).getByRole("button", { name: "Move…" });
    await user.click(button);
    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    await waitFor(() => expect(button).toBeEnabled());
    expect(moveProject).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    await expect(
      withCommandSendOwnership(projectPath, "shared", async () => "saved"),
    ).resolves.toBe("saved");
  });

  it("shows what to do when it cannot check the saved edit queue", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(loadHostCommandCount).mockRejectedValueOnce(
      new Error("Invalid saved command list"),
    );
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    expect(
      await within(sheet).findByText(
        "Couldn't check whether all edits are saved. Keep this episode open and try Move again when editing has finished.",
      ),
    ).toBeVisible();
    expect(pickFolder).not.toHaveBeenCalled();
    expect(moveProject).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("reports an uncertain result when the move response has no folder path", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
    vi.mocked(moveProject).mockResolvedValue({
      project_path: "",
      previous_path: projectPath,
    });
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    expect(
      await within(sheet).findByText(
        "Couldn't confirm where this episode is. Check the folder you chose and the original folder before trying again.",
      ),
    ).toBeVisible();
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows the server's refusal under the row and keeps the episode where it is", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
    vi.mocked(moveProject).mockRejectedValue(
      new ApiError(
        "Someone else has this episode open in another window.",
        "move_others_connected",
        409,
      ),
    );
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    const button = within(sheet).getByRole("button", { name: "Move…" });
    await user.click(button);
    expect(
      await within(sheet).findByText(
        "Someone else has this episode open in another window.",
      ),
    ).toBeVisible();
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toHaveFocus());
  });

  it.each(["before reopen", "after reopen"])(
    "retires a closed opening's Move refusal when it arrives %s",
    async (settlement) => {
      tauri.on = true;
      inProject(projectPath);
      const pending = deferred<Awaited<ReturnType<typeof moveProject>>>();
      vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
      vi.mocked(moveProject).mockReturnValueOnce(pending.promise);
      const user = userEvent.setup();
      render(<Harness />);
      let sheet = await openSettings();
      await user.click(within(sheet).getByRole("button", { name: "Move…" }));
      await waitFor(() => expect(moveProject).toHaveBeenCalledOnce());
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();

      if (settlement === "after reopen") {
        sheet = await openSettings();
        const moving = within(sheet).getByRole("button", { name: "Moving…" });
        const reveal = within(sheet).getByRole("button", {
          name: "Reveal in folder",
        });
        expect(moving).toBeDisabled();
        expect(reveal).toBeDisabled();
        expect(moving).toHaveAttribute("aria-busy", "true");
        expect(reveal).not.toHaveAttribute("aria-busy");
        await user.click(moving);
        await user.click(reveal);
        expect(moveProject).toHaveBeenCalledOnce();
        expect(pickFolder).toHaveBeenCalledOnce();
        expect(revealProject).not.toHaveBeenCalled();
      }
      await act(async () =>
        pending.reject(
          new ApiError("Old Move refusal", "move_dest_invalid", 400),
        ),
      );
      if (settlement === "before reopen") sheet = await openSettings();
      expect(within(sheet).queryByRole("alert")).toBeNull();
      expect(
        within(sheet).getByRole("button", { name: "Move…" }),
      ).toBeEnabled();
      expect(assign).not.toHaveBeenCalled();

      vi.mocked(moveProject).mockRejectedValueOnce(
        new ApiError("New Move refusal", "move_others_connected", 409),
      );
      await user.click(within(sheet).getByRole("button", { name: "Move…" }));
      expect(await within(sheet).findByRole("alert")).toHaveTextContent(
        "New Move refusal",
      );
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "partial move"])(
    "navigates after close on %s and keeps both actions disabled until unload",
    async (outcome) => {
      tauri.on = true;
      inProject(projectPath);
      const destination = "/Users/ada/Archive/ep-12/episode.sharecut";
      const pending = deferred<Awaited<ReturnType<typeof moveProject>>>();
      vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
      vi.mocked(moveProject).mockReturnValueOnce(pending.promise);
      const user = userEvent.setup();
      render(<Harness />);
      let sheet = await openSettings();
      await user.click(within(sheet).getByRole("button", { name: "Move…" }));
      await waitFor(() => expect(moveProject).toHaveBeenCalledOnce());
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
      await act(async () => {
        if (outcome === "success") {
          pending.resolve({
            project_path: destination,
            previous_path: projectPath,
          });
        } else {
          pending.reject(
            new ApiError(
              "Some links could not be updated.",
              "project_moved_partial",
              409,
              null,
              {
                detail: { project_path: destination },
              },
            ),
          );
        }
      });
      expect(assign).toHaveBeenCalledOnce();
      expect(String(assign.mock.calls[0]?.[0])).toContain(
        encodeURIComponent(destination),
      );
      await expect(
        withCommandSendOwnership(projectPath, "shared", async () => "saved"),
      ).rejects.toThrow(/episode is moving/i);
      sheet = await openSettings();
      expect(
        within(sheet).getByRole("button", { name: "Moving…" }),
      ).toBeDisabled();
      expect(
        within(sheet).getByRole("button", { name: "Reveal in folder" }),
      ).toBeDisabled();
      expect(within(sheet).queryByRole("alert")).toBeNull();
    },
  );

  it("follows the folder when the move only half finished", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
    vi.mocked(moveProject).mockRejectedValue(
      new ApiError(
        "The episode moved, but some links could not be updated.",
        "project_moved_partial",
        409,
        null,
        {
          detail: {
            detail: "The episode moved, but some links could not be updated.",
            project_path: "/Users/ada/Archive/ep-12/episode.sharecut",
          },
        },
      ),
    );
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(String(assign.mock.calls[0]?.[0])).toContain(
      encodeURIComponent("/Users/ada/Archive/ep-12/episode.sharecut"),
    );
  });

  it("stays disabled once the move succeeded, until the page unloads", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
    vi.mocked(moveProject).mockResolvedValue({
      project_path: "/Users/ada/Archive/ep-12/episode.sharecut",
      previous_path: projectPath,
    });
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    const button = within(sheet).getByRole("button", { name: "Move…" });
    await user.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(
      within(sheet).getByRole("button", { name: "Moving…" }),
    ).toBeDisabled();
  });

  it("waits while edits are still queued, without opening the dialog", async () => {
    tauri.on = true;
    inProject(projectPath);
    queued.count = 2;
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    expect(
      await within(sheet).findByText(/edits are still waiting to be saved/),
    ).toBeVisible();
    expect(pickFolder).not.toHaveBeenCalled();
    expect(moveProject).not.toHaveBeenCalled();
  });

  it("re-checks the queue after the folder is picked", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(pickFolder).mockImplementationOnce(async () => {
      queued.count = 1;
      return { folder: "/Volumes/Archive" };
    });
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    expect(
      await within(sheet).findByText(/edits are still waiting to be saved/),
    ).toBeVisible();
    expect(moveProject).not.toHaveBeenCalled();
  });

  it("refuses new command admission while moving and restores it after a refusal", async () => {
    tauri.on = true;
    inProject(projectPath);
    const pending = deferred<Awaited<ReturnType<typeof moveProject>>>();
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Volumes/Archive" });
    vi.mocked(moveProject).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    await waitFor(() => expect(moveProject).toHaveBeenCalledOnce());

    const save = vi.fn(async () => "saved");
    await expect(
      withCommandSendOwnership(projectPath, "shared", save),
    ).rejects.toThrow(/episode is moving/i);
    expect(save).not.toHaveBeenCalled();

    await act(async () =>
      pending.reject(new ApiError("The folder is in use.", "move_in_use", 409)),
    );
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "The folder is in use.",
    );
    await expect(
      withCommandSendOwnership(projectPath, "shared", save),
    ).resolves.toBe("saved");
    expect(save).toHaveBeenCalledOnce();
  });

  it("waits for an admitted send even before its edit can reach the queue", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Volumes/Archive" });
    const pending = deferred<string>();
    const save = vi.fn(() => pending.promise);
    const command = withCommandSendOwnership(projectPath, "shared", save);
    try {
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      const user = userEvent.setup();
      render(<Harness />);
      const sheet = await openSettings();
      await user.click(within(sheet).getByRole("button", { name: "Move…" }));
      expect(
        await within(sheet).findByText(/edits are still waiting to be saved/),
      ).toBeVisible();
      expect(moveProject).not.toHaveBeenCalled();
    } finally {
      pending.resolve("saved");
      await command;
    }
  });

  it("says so when the computer has no folder dialog", async () => {
    tauri.on = true;
    inProject(projectPath);
    vi.mocked(pickFolder).mockResolvedValue({
      unavailable: true,
      detail: "no dialog; paste the path instead.",
    });
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    expect(
      await within(sheet).findByText(/couldn't open a folder dialog/),
    ).toBeVisible();
    expect(within(sheet).queryByText(/paste the path/)).toBeNull();
    expect(moveProject).not.toHaveBeenCalled();
  });
});

describe("Models and Keyboard shortcuts rows", () => {
  it("closes Settings, opens Models, and returns focus to the app menu on close", async () => {
    inProject();
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: "App menu" }).focus();
    const sheet = await openSettings();
    await waitForDialogFocus(sheet);
    await user.click(within(sheet).getByRole("button", { name: "Models" }));
    expect(useDawStore.getState().chrome.settingsSheetOpen).toBe(false);
    expect(useDawStore.getState().chrome.modelsSheetOpen).toBe(true);
    const models = await screen.findByRole("dialog", { name: "Models" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    await waitForDialogFocus(models);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "App menu" })).toHaveFocus(),
    );
  });

  it("closes Settings and opens the palette with search focused", async () => {
    inProject();
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(
      within(sheet).getByRole("button", { name: "Keyboard shortcuts" }),
    );
    expect(useDawStore.getState().chrome.settingsSheetOpen).toBe(false);
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(true);
    const search = await screen.findByRole("combobox", {
      name: "Search commands",
    });
    await waitFor(() => expect(search).toHaveFocus());
  });
});

function ProjectHeader() {
  const { preference, setPreference } = useTheme();
  return (
    <AppHeader
      title="Ep"
      appearance={{ value: preference, onChange: setPreference }}
    />
  );
}

describe("Appearance", () => {
  it("is a radiogroup that moves with the arrow keys", async () => {
    inProject();
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    const group = within(sheet).getByRole("radiogroup", { name: "Appearance" });
    expect(within(group).getByRole("radio", { name: "System" })).toBeChecked();
    await user.click(within(group).getByRole("radio", { name: "Dark" }));
    expect(within(group).getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("daw_theme")).toBe("dark");
    await user.keyboard("{ArrowLeft}");
    expect(within(group).getByRole("radio", { name: "Light" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Light" })).toHaveFocus();
  });

  it("picked in Settings, shows in the Project menu's radio", async () => {
    inProject();
    const user = userEvent.setup();
    render(
      <>
        <ProjectHeader />
        <Harness />
      </>,
    );
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("radio", { name: "Dark" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /Ep/ }));
    expect(
      await screen.findByRole("menuitemradio", { name: "Dark" }),
    ).toBeChecked();
    expect(
      screen.getByRole("menuitemradio", { name: "System" }),
    ).not.toBeChecked();
  });
});

describe("native Settings menu item", () => {
  it("opens the sheet when the desktop shell dispatches the open event", async () => {
    registerHostCommands();
    inProject();
    render(<Harness />);
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    act(() => {
      window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
    });
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });
});
