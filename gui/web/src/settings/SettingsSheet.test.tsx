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
import { CommandPalette } from "../stage/dialogs/CommandPalette";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { AppHeader } from "../system/AppHeader";
import { expectNoA11yViolations } from "../test/a11y";
import { setChrome } from "../test/chrome";
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

function inProject() {
  useDawStore.getState().hydrate(PROJECT_PATH, minimalProject());
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

  it("shows the server's refusal under the row and keeps the sheet open", async () => {
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
  beforeEach(() => {
    queued.count = 0;
    assign.mockReset();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=%2FUsers%2Fada%2FEpisodes%2Fep-12%2Fepisode.sharecut",
      assign,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is absent outside the desktop app", async () => {
    inProject();
    render(<Harness />);
    const sheet = await openSettings();
    expect(within(sheet).queryByRole("button", { name: "Move…" })).toBeNull();
  });

  it("moves the episode to the picked folder and reloads at the new path", async () => {
    tauri.on = true;
    inProject();
    useDawStore.setState({ localClientId: "tab-1" });
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
    vi.mocked(moveProject).mockResolvedValue({
      project_path: "/Users/ada/Archive/ep-12/episode.sharecut",
      previous_path: PROJECT_PATH,
    });
    const user = userEvent.setup();
    render(<Harness />);
    const sheet = await openSettings();
    await user.click(within(sheet).getByRole("button", { name: "Move…" }));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(moveProject).toHaveBeenCalledWith(
      PROJECT_PATH,
      "/Users/ada/Archive",
      "tab-1",
    );
    expect(String(assign.mock.calls[0]?.[0])).toContain(
      encodeURIComponent("/Users/ada/Archive/ep-12/episode.sharecut"),
    );
  });

  it("changes nothing when the folder dialog is cancelled", async () => {
    tauri.on = true;
    inProject();
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
  });

  it("shows the server's refusal under the row and keeps the episode where it is", async () => {
    tauri.on = true;
    inProject();
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

  it("follows the folder when the move only half finished", async () => {
    tauri.on = true;
    inProject();
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
    inProject();
    vi.mocked(pickFolder).mockResolvedValue({ folder: "/Users/ada/Archive" });
    vi.mocked(moveProject).mockResolvedValue({
      project_path: "/Users/ada/Archive/ep-12/episode.sharecut",
      previous_path: PROJECT_PATH,
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
    inProject();
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
    inProject();
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

  it("says so when the computer has no folder dialog", async () => {
    tauri.on = true;
    inProject();
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
