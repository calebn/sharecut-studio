import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentProject } from "../../api";
import { listRecentProjects } from "../../api";
import { COMMANDS } from "../../commands/catalog";
import { registerCommand } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { getKeymapOverride } from "../../keymap/remaps";
import { useDawStore } from "../../state/dawStore";
import { presenceProjectInitial } from "../../state/presenceSlice";
import { DawProvider } from "../../state/store";
import { setChrome } from "../../test/chrome";
import { waitForDialogFocus } from "../../test/dialogFocus";
import { minimalProject, sessionRoster } from "../../test/fixtures";
import { CommandPalette } from "./CommandPalette";

const ctxOverride = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listRecentProjects: vi.fn(),
}));

// Lets a test close a gate after the palette built its rows, without a re-render.
vi.mock("../../commands/context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../commands/context")>();
  return {
    ...actual,
    buildCommandContext: (
      ...args: Parameters<typeof actual.buildCommandContext>
    ) => ({
      ...actual.buildCommandContext(...args),
      ...ctxOverride.value,
    }),
  };
});

const recentProject: RecentProject = {
  path: "/p/Gala",
  name: "Gala",
  opened_at: "",
  edited_at: null,
  duration_sec: null,
  stage: "edit",
  chip: { text: "Ready", state: "ready" },
  peaks: [],
  folder_missing: false,
};

function renderPalette(path = "/tmp/p.json", scope?: "home") {
  return render(
    <DawProvider projectPath={path} initialProject={minimalProject()}>
      <CommandPalette scope={scope} />
    </DawProvider>,
  );
}

const STAGE_ROW_LABELS = [
  "Go to Deliver",
  "Go to Edit",
  "Go to Prepare",
  "Go to Record",
  "Go to Review",
  "Take the hand-off",
];

describe("CommandPalette", () => {
  beforeEach(() => {
    ctxOverride.value = null;
    vi.mocked(listRecentProjects).mockReset();
    vi.mocked(listRecentProjects).mockResolvedValue([]);
    localStorage.clear();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setCommandPaletteOpen(true);
    setChrome({ exportRequested: false });
    useDawStore.setState({ pointerKind: "fine" });
    useDawStore.setState({
      stage: "edit",
      statusAnnouncement: "",
      ...presenceProjectInitial(),
    });
  });

  afterEach(() => {
    useDawStore.setState(presenceProjectInitial());
  });

  it("lists keyed and keyless catalog commands together", () => {
    renderPalette();
    expect(
      screen.getByRole("dialog", { name: "Commands and shortcuts" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Fit session width \\" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Show cut away" })).toBeTruthy();
  });

  it("omits argument-only and context-only commands", () => {
    renderPalette();
    for (const label of [
      "Seek playhead",
      COMMANDS["transport.audition"].label,
      "Follow",
      "Resolve comment",
      "Reorder track",
      "Move clips",
      "Switch editor tab",
      "Switch phone mode",
      "Correct transcript",
      "Select transcript range",
      "Trim clip edge",
      "Roll clip join",
      "Set clip fade",
      "Focus edit boundary",
      "Focus cut-away word",
    ]) {
      expect(
        screen.queryByRole("option", {
          name: (name) => name === label || name.startsWith(`${label} `),
        }),
      ).toBeNull();
    }
  });

  it("finds a command by search, closes, and runs it", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    await user.keyboard("show cut away{Enter}");
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
    await waitFor(() =>
      expect(useDawStore.getState().showCutAwayUtterances).toBe(true),
    );
  });

  it("closes the palette and goes to Deliver to export, never stacked", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    await user.keyboard("export deliv");
    await user.click(
      screen.getByRole("option", { name: /^Export deliverables…/ }),
    );
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
    await waitFor(() =>
      expect(useDawStore.getState().chrome.exportRequested).toBe(true),
    );
    expect(useDawStore.getState().stage).toBe("deliver");
  });

  it("remaps a key with Tab and Enter, shows it in the row, and restores the default when emptied", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    await user.type(screen.getByRole("combobox"), "Fit session width");
    await user.keyboard("{Tab}Q{Enter}");
    expect(getKeymapOverride("view.fit")).toEqual(["Q"]);
    expect(
      screen.getByRole("option", { name: /^Fit session width/ }),
    ).toHaveTextContent(/Q/);
    await user.keyboard("{Tab}{Enter}");
    expect(getKeymapOverride("view.fit")).toEqual(["Q"]);
    await user.keyboard("{Tab}Q{Backspace}{Enter}");
    expect(getKeymapOverride("view.fit")).toBeUndefined();
  });

  it("closes on Escape", async () => {
    renderPalette();
    await waitForDialogFocus();
    await userEvent.keyboard("{Escape}");
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
  });

  it("keeps Tab focus inside the panel", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <div data-daw-app-chrome>
          <button type="button">Chrome target</button>
        </div>
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject()}
        >
          <CommandPalette />
        </DawProvider>
      </div>,
    );
    await waitForDialogFocus();
    await user.tab();
    expect(
      document.activeElement?.closest(".command-palette-panel"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Chrome target" }),
    ).not.toHaveFocus();
  });

  it("does not repeat a refusal the command already announced", async () => {
    const raw = "Reorder failed: set PODCAST_MCP_FFMPEG to its bin executable.";
    registerCommand("view.fit", async () => {
      useDawStore.getState().announceStatus(raw, { tone: "error" });
      return { status: "disabled", reason: raw, told: true };
    });
    const before = useDawStore.getState().statusAnnouncementSeq;
    renderPalette();
    await userEvent
      .setup()
      .click(screen.getByRole("option", { name: "Fit session width \\" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncementSeq).toBe(before + 1),
    );
    await new Promise((r) => setTimeout(r, 20));
    const state = useDawStore.getState();
    expect(state.statusAnnouncementSeq).toBe(before + 1);
    expect(state.feedbackToast).toMatchObject({
      tone: "error",
      message:
        "Reorder failed. Export diagnostics from the command palette and try again.",
    });
  });

  async function runFit(
    handler: Parameters<typeof registerCommand>[1],
  ): Promise<void> {
    registerCommand("view.fit", handler);
    renderPalette();
    await userEvent
      .setup()
      .click(screen.getByRole("option", { name: "Fit session width \\" }));
    await new Promise((r) => setTimeout(r, 20));
  }

  it("shows the refusal a command returns even when it announced something else", async () => {
    await runFit(async () => {
      useDawStore.getState().announceStatus("first");
      return { status: "disabled", reason: "SECOND never spoken" };
    });
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      "SECOND never spoken",
    );
  });

  it("keeps the words of a failure the command told itself", async () => {
    await runFit(async () => {
      useDawStore
        .getState()
        .announceStatus("Fit failed: no tracks", { tone: "error" });
      return { status: "disabled", reason: "no tracks", told: true };
    });
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      "Fit failed: no tracks",
    );
    expect(useDawStore.getState().feedbackToast?.tone).toBe("error");
  });

  it("shows the refusal of a silent command when an unrelated announcement lands meanwhile", async () => {
    await runFit(async () => {
      await Promise.resolve();
      useDawStore
        .getState()
        .announceStatus("Export: running", { toast: false });
      return { status: "disabled", reason: "Nothing selected" };
    });
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      "Nothing selected",
    );
  });

  it("keeps a standing Undo toast when a refusal was already spoken without a toast", async () => {
    useDawStore
      .getState()
      .announceStatus("Moved clips", { undo: "h-1" as never });
    const standing = useDawStore.getState().feedbackToast;
    const before = useDawStore.getState().statusAnnouncementSeq;
    await runFit(async () => {
      useDawStore.getState().announceStatus("Can't undo: it changed.", {
        toast: false,
        tone: "error",
      });
      return {
        status: "disabled",
        reason: "Can't undo: it changed.",
        told: true,
      };
    });
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(before + 1);
    expect(useDawStore.getState().feedbackToast).toBe(standing);
  });

  it("lists chapters and a click seeks there through the registry", async () => {
    const seen: unknown[] = [];
    registerCommand("transport.seek", (args) => {
      seen.push(args);
      return { status: "ok" };
    });
    renderPalette();
    act(() =>
      useDawStore.setState({
        project: {
          ...minimalProject(),
          chapters: [{ time: 12, title: "Cold open" }],
        },
      }),
    );
    expect(screen.getByRole("group", { name: "Chapters" })).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("option", { name: /^Cold open/ }));
    expect(seen).toEqual([{ sec: 12 }]);
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
  });

  it("lists Stages and Help as groups, and a stage row switches stage through the registry", async () => {
    renderPalette();
    expect(
      within(screen.getByRole("group", { name: "Stages" }))
        .getAllByRole("option")
        .map((o) => o.textContent?.match(/^(Go to \w+|Take the hand-off)/)?.[0])
        .sort(),
    ).toEqual(STAGE_ROW_LABELS);
    expect(
      within(screen.getByRole("group", { name: "Help" })).getByRole("option", {
        name: /^Export diagnostics…/,
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Navigation" })).queryByRole(
        "option",
        { name: /Go to Deliver/ },
      ),
    ).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("option", { name: /^Go to Deliver/ }));
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
    await waitFor(() => expect(useDawStore.getState().stage).toBe("deliver"));
  });

  it.each([
    ["coarse", undefined, true],
    ["fine", undefined, false],
    ["coarse", "home" as const, false],
  ] as const)(
    "with a %s pointer on %s shows the Gestures rows: %s",
    (kind, scope, shown) => {
      useDawStore.setState({ pointerKind: kind });
      renderPalette("/tmp/p.json", scope);
      expect(!!screen.queryByRole("group", { name: "Gestures" })).toBe(shown);
    },
  );

  it("hides Projects, People and Chapters when there is no data", () => {
    renderPalette();
    for (const name of ["Projects", "People", "Chapters", "Recent"]) {
      expect(screen.queryByRole("group", { name })).toBeNull();
    }
  });

  it("remembers what ran and shows it as Recent on the next open", async () => {
    registerCommand("view.fit", () => ({ status: "ok" }));
    const user = userEvent.setup();
    renderPalette();
    await user.click(
      screen.getByRole("option", { name: "Fit session width \\" }),
    );
    expect(
      JSON.parse(localStorage.getItem("sharecut.palette.recent.v1") ?? "[]"),
    ).toEqual(["view.fit"]);
    useDawStore.getState().setCommandPaletteOpen(true);
    const recent = await screen.findByRole("group", { name: "Recent" });
    expect(
      within(recent).getByRole("option", { name: "Fit session width \\" }),
    ).toBeTruthy();
  });

  it("remembers a stage command as Recent without repeating it in Stages", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole("option", { name: /^Go to Edit/ }));
    expect(
      JSON.parse(localStorage.getItem("sharecut.palette.recent.v1") ?? "[]"),
    ).toEqual(["stage.edit"]);
    act(() => useDawStore.getState().setCommandPaletteOpen(true));
    const recent = await screen.findByRole("group", { name: "Recent" });
    expect(
      within(recent).getAllByRole("option", { name: /^Go to Edit/ }),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("group", { name: "Stages" }))
        .getAllByRole("option")
        .map((o) => o.textContent?.match(/^(Go to \w+|Take the hand-off)/)?.[0])
        .sort(),
    ).toEqual(STAGE_ROW_LABELS);
    const ids = screen.getAllByRole("option").map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows the Help row enabled for the host and disabled with its reason on a review link", () => {
    const { unmount } = renderPalette();
    expect(
      screen.getByRole("option", { name: /^Export diagnostics…/ }),
    ).not.toHaveAttribute("aria-disabled");
    unmount();
    useDawStore
      .getState()
      .hydrate("share:tok", minimalProject(), "view", ["play"]);
    useDawStore.getState().setCommandPaletteOpen(true);
    renderPalette("share:tok");
    const row = screen.getByRole("option", { name: /^Export diagnostics…/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row.textContent).toMatch(/host/i);
  });

  it("finds the Stage rows by typing stages and the Help row by typing help", async () => {
    const user = userEvent.setup();
    renderPalette();
    await waitForDialogFocus();
    await user.keyboard("stages");
    expect(
      screen
        .getAllByRole("option")
        .filter((o) => /^Go to /.test(o.textContent ?? "")),
    ).toHaveLength(5);
    await user.clear(screen.getByRole("combobox"));
    await user.keyboard("help");
    expect(
      screen.getByRole("option", { name: /^Export diagnostics…/ }),
    ).toBeTruthy();
  });

  it("fetches the host's recent projects on a host link and lists them", async () => {
    vi.mocked(listRecentProjects).mockResolvedValue([recentProject]);
    renderPalette();
    const projects = await screen.findByRole("group", { name: "Projects" });
    expect(
      within(projects).getByRole("option", { name: /^Gala/ }),
    ).toBeTruthy();
    expect(listRecentProjects).toHaveBeenCalledTimes(1);
  });

  it("leaves the Projects group out when the fetch fails", async () => {
    vi.mocked(listRecentProjects).mockRejectedValue(new Error("offline"));
    renderPalette();
    await waitFor(() => expect(listRecentProjects).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("group", { name: "Projects" })).toBeNull();
    expect(screen.getByRole("option", { name: "Show cut away" })).toBeTruthy();
  });

  it("never fetches projects on a guest link", async () => {
    useDawStore.getState().hydrate("share:tok", minimalProject());
    vi.mocked(listRecentProjects).mockResolvedValue([recentProject]);
    renderPalette("share:tok");
    await act(async () => {});
    expect(listRecentProjects).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Projects" })).toBeNull();
  });

  it("aborts the projects fetch when the palette closes", async () => {
    vi.mocked(listRecentProjects).mockReturnValue(new Promise(() => {}));
    renderPalette();
    await waitFor(() => expect(listRecentProjects).toHaveBeenCalled());
    const signal = vi.mocked(listRecentProjects).mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);
    act(() => useDawStore.getState().setCommandPaletteOpen(false));
    expect(signal?.aborted).toBe(true);
  });

  it("lists live remote clients as People and follows one on click", async () => {
    renderPalette();
    act(() =>
      useDawStore.setState({
        localClientId: "me",
        sessionClients: sessionRoster([
          {
            client_id: "me",
            role: "owner",
            last_seen_ns: Date.now() * 1e6,
          },
          {
            client_id: "ana-1",
            label: "Ana",
            role: "editor",
            last_seen_ns: Date.now() * 1e6,
          },
        ]),
      }),
    );
    const people = screen.getByRole("group", { name: "People" });
    expect(within(people).getAllByRole("option")).toHaveLength(1);
    await userEvent
      .setup()
      .click(within(people).getByRole("option", { name: /^Ana/ }));
    expect(useDawStore.getState().followingClientId).toBe("ana-1");
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
  });

  it("runs nothing and says why when an entry's gate closed after open", async () => {
    vi.mocked(listRecentProjects).mockResolvedValue([recentProject]);
    const open = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("project.open", open);
    const user = userEvent.setup();
    renderPalette();
    await screen.findByRole("group", { name: "Projects" });
    await waitForDialogFocus();
    await user.keyboard("gala");
    ctxOverride.value = { canManageProjects: false };
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).not.toBe(""),
    );
    expect(open).not.toHaveBeenCalled();
    expect(useDawStore.getState().statusAnnouncement).toMatch(/host-only/i);
    expect(useDawStore.getState().chrome.commandPaletteOpen).toBe(false);
  });
});
