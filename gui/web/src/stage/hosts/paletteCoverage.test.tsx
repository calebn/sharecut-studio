import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../../commands/catalog";
import { buildCommandContext } from "../../commands/context";
import { registerCommand } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { FeaturesContext } from "../../extensions/FeaturesContext";
import { FEATURE_SHARE_UI_MENU } from "../../extensions/features";
import { THEME_STORAGE_KEY } from "../../hooks/useTheme";
import { pickAudioFiles } from "../../ingest/ingestFiles";
import { useRecordHostStore } from "../../record/hostStore";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import {
  minimalProject,
  sampleTrack,
  sessionRoster,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { CommandPalette } from "../dialogs/CommandPalette";
import { paletteCommands } from "../dialogs/commandPaletteRows";
import { EditCorner } from "../edit/EditCorner";
import { EditToolStrip } from "../edit/EditToolStrip";
import { EDIT_SHEETS } from "../edit/editSheets";
import { PlusMenu } from "../edit/PlusMenu";
import { ViewSheet } from "../edit/ViewSheet";
import { PlayerBar } from "../frame/PlayerBar";
import { StageFrame } from "../frame/StageFrame";
import { StageHost } from "./StageHost";

/**
 * Every command that was reachable from the transport Menu, the View menu, the layout presets, the phone More hub or
 * the tool rail is still a catalog command the palette lists, or its new home
 * is on screen. A home is rendered, not looked up in the source: the probe
 * mounts the real component, finds the control by its role and name, and
 * where the home runs a command, presses it and sees that command run. So an
 * unmounted slot or a dropped prop fails here.
 */

vi.mock("../../ingest/ingestFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ingest/ingestFiles")>()),
  pickAudioFiles: vi.fn(async () => []),
}));
vi.mock("../../panels/ImpactPanel", () => ({
  ImpactPanel: () => <div>impact panel</div>,
}));
vi.mock("../../panels/TightenPanel", () => ({
  TightenPanel: () => <div>tighten panel</div>,
}));
vi.mock("../../panels/CommentsPanel", () => ({
  CommentsPanel: () => <div>comments panel</div>,
}));
vi.mock("../edit/EditWorkspace", () => ({
  EditWorkspace: () => <div>edit workspace</div>,
}));

const HOST_PATH = "/tmp/palette-coverage/episode.project.json";

type User = ReturnType<typeof userEvent.setup>;
type Probe = (user: User) => Promise<void>;

type Surface =
  | "transport Menu"
  | "View menu"
  | "layout presets"
  | "More hub"
  | "tool rail"
  | "transport bar";

type Entry = {
  surface: Surface;
  label: string;
  command?: string;
  home?: Probe[];
};

const entry = (
  surface: Surface,
  label: string,
  command: string,
  home?: Probe[],
): Entry => ({ surface, label, command, home });

const component = (surface: Surface, label: string, home: Probe[]): Entry => ({
  surface,
  label,
  home,
});

/** A stale mix with an old premix: Deliver offers Refresh mix. */
const staleProject = () =>
  minimalProject({
    tracks: [sampleTrack({ stem_is_fresh: true })],
    render_status: {
      needs_rerender: true,
      reconciliation: { stale: false },
      premix: { exists: true },
    },
  });

function asHost(stage: "edit" | "prepare" | "review" | "deliver" | "record") {
  useDawStore
    .getState()
    .hydrate(HOST_PATH, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({
    stage,
    guestMode: null,
    localClientId: "me",
    sessionClients: sessionRoster([
      {
        client_id: "me",
        role: "host",
        last_seen_ns: Date.now() * 1e6,
        meta: { display_name: "Me", color_index: 1 },
      },
      {
        client_id: "maya",
        role: "viewer",
        last_seen_ns: Date.now() * 1e6,
        meta: { display_name: "Maya", color_index: 2 },
      },
    ]),
  });
}

function mountFrame() {
  asHost("edit");
  render(
    <StageFrame sheets={EDIT_SHEETS}>
      <p>stage body</p>
    </StageFrame>,
  );
}

function mountStage(stage: "prepare" | "review" | "deliver" | "record") {
  asHost(stage);
  render(
    <FeaturesContext.Provider
      value={{
        ready: true,
        manifest: { api_version: 1, features: [FEATURE_SHARE_UI_MENU] },
      }}
    >
      <StageHost />
    </FeaturesContext.Provider>,
  );
}

/** Replaces a command's handler with a spy: the home must run exactly it. */
function spyOn(id: string) {
  const spy = vi.fn(async () => ({ status: "ok" }) as const);
  registerCommand(id, spy);
  return spy;
}

async function runs(id: string, press: () => Promise<void>) {
  const spy = spyOn(id);
  await press();
  await waitFor(() => expect(spy, `${id} did not run`).toHaveBeenCalled());
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

async function openProjectMenu(user: User) {
  mountFrame();
  await user.click(button(/Test Episode/));
}

const headerPalette: Probe = async (user) => {
  mountFrame();
  await runs("ui.toggleCommandPalette", () => user.click(button(/Palette/)));
};

const headerInvite: Probe = async (user) => {
  mountFrame();
  await runs("share.manage", () => user.click(button("Invite")));
};

const projectMenuRow =
  (name: string, id: string): Probe =>
  async (user) => {
    await openProjectMenu(user);
    await runs(id, () => user.click(screen.getByRole("menuitem", { name })));
  };

const themeRow: Probe = async (user) => {
  await openProjectMenu(user);
  const dark = screen.getByRole("menuitemradio", { name: "Dark" });
  expect(dark).toHaveAttribute("aria-checked", "false");
  await user.click(dark);
  expect(dark).toHaveAttribute("aria-checked", "true");
};

/** The header's people control opens a menu whose rows follow someone. */
const peopleSlot: Probe = async (user) => {
  mountFrame();
  await user.click(button(/People here, 1/));
  await runs("presence.follow", () =>
    user.click(screen.getByRole("menuitem", { name: /Maya/ })),
  );
};

const auditionMenu: Probe = async (user) => {
  asHost("edit");
  render(<PlayerBar />);
  expect(screen.getByRole("group", { name: "Audition" })).toBeInTheDocument();
  await user.click(button("Hear options"));
  await runs("transport.audition", () =>
    user.click(
      screen.getByRole("menuitemradio", { name: "Without mix processing" }),
    ),
  );
};

const historySheet: Probe = async () => {
  mountFrame();
  useDawStore.setState({ openSheet: "history" });
  expect(
    await screen.findByRole("dialog", { name: "History" }),
  ).toBeInTheDocument();
};

const mixSheet: Probe = async () => {
  mountFrame();
  useDawStore.setState({ openSheet: "mix" });
  expect(
    await screen.findByRole("dialog", { name: "Mix" }),
  ).toBeInTheDocument();
};

const homeScreenHint: Probe = async () => {
  for (const [key, value] of Object.entries({
    standalone: false,
    maxTouchPoints: 5,
  })) {
    Object.defineProperty(navigator, key, { value, configurable: true });
  }
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
  mountFrame();
  expect(
    screen.getByRole("complementary", { name: "Full screen" }),
  ).toBeInTheDocument();
};

const gesturesButton: Probe = async () => {
  asHost("edit");
  useDawStore.getState().setCommandPaletteOpen(true);
  render(
    <DawProvider projectPath={HOST_PATH} initialProject={minimalProject()}>
      <CommandPalette />
    </DawProvider>,
  );
  expect(button("Gestures")).toBeInTheDocument();
};

const deliverButton =
  (name: string, id: string): Probe =>
  async (user) => {
    mountStage("deliver");
    await runs(id, () => user.click(button(name)));
  };

const refreshMixRow: Probe = async (user) => {
  asHost("deliver");
  useDawStore.getState().setProject(staleProject());
  render(<StageHost />);
  await runs("render.refreshMix", () =>
    user.click(screen.getByRole("button", { name: "Refresh mix" })),
  );
};

const recordRoom: Probe = async (user) => {
  mountStage("record");
  await runs("record.openPanel", () => user.click(button("Open the room")));
};

const importAudio: Probe = async (user) => {
  mountStage("prepare");
  vi.mocked(pickAudioFiles).mockClear();
  await user.click(button(/Import audio/));
  await waitFor(() => expect(pickAudioFiles).toHaveBeenCalled());
};

const pipeline: Probe = async () => {
  mountStage("prepare");
  expect(button(/Advanced/)).toBeInTheDocument();
};

const reviewSection =
  (tab: RegExp, panel: string): Probe =>
  async (user) => {
    mountStage("review");
    const tabs = within(
      screen.getByRole("tablist", { name: "Review sections" }),
    );
    await user.click(tabs.getByRole("tab", { name: tab }));
    expect(screen.getByText(panel)).toBeInTheDocument();
  };

const plusMenuRow =
  (name: RegExp, id: string): Probe =>
  async (user) => {
    asHost("edit");
    render(<PlusMenu />);
    await user.click(button("+"));
    await runs(id, () => user.click(screen.getByRole("menuitem", { name })));
  };

const cornerButton =
  (name: string, id: string): Probe =>
  async (user) => {
    asHost("edit");
    render(<EditCorner />);
    await runs(id, () => user.click(button(name)));
  };

const toolStripButton =
  (name: string, id: string): Probe =>
  async (user) => {
    asHost("edit");
    render(<EditToolStrip />);
    await runs(id, () => user.click(button(name)));
  };

const viewLayers: Probe = async () => {
  asHost("edit");
  render(<ViewSheet />);
  const layers = screen.getByRole("region", { name: "Layers" });
  expect(
    within(layers).getByRole("checkbox", { name: /Markers/ }),
  ).toBeInTheDocument();
};

/** A ViewSheet section's `index`th button runs `id`. */
const viewSheetButton =
  (region: string, index: number, id: string): Probe =>
  async (user) => {
    asHost("edit");
    render(<ViewSheet />);
    const section = screen.getByRole("region", { name: region });
    await runs(id, () =>
      user.click(within(section).getAllByRole("button")[index]),
    );
  };

const fitTracksHeight: Probe = async (user) => {
  asHost("edit");
  render(<ViewSheet />);
  const section = screen.getByRole("region", { name: "Track height" });
  await runs("view.fitTracksHeight", () =>
    user.click(within(section).getByRole("checkbox")),
  );
};

const REMOVED_SURFACES: Entry[] = [
  // Transport Menu: Timeline tools, Project, Media, Markers, Selection, Help.
  entry("transport Menu", "Select tool", "tool.select"),
  entry("transport Menu", "Blade tool", "tool.blade"),
  entry("transport Menu", "Select a range", "range.arm"),
  entry("transport Menu", "Cut at playhead", "edit.bladeCut"),
  entry("transport Menu", "New project", "project.new"),
  entry("transport Menu", "Open project", "project.open"),
  entry("transport Menu", "Bounce", "export.bounce", [
    deliverButton("Bounce…", "export.bounce"),
  ]),
  entry("transport Menu", "Export deliverables", "export.deliverables", [
    deliverButton("Export", "export.deliverables"),
  ]),
  entry("transport Menu", "Share", "share.manage", [
    deliverButton("Share a listen link", "share.manage"),
    headerInvite,
  ]),
  entry("transport Menu", "Record room", "record.openPanel", [recordRoom]),
  entry("transport Menu", "Connect agent", "mcp.connect", [
    projectMenuRow("Connect agent", "mcp.connect"),
  ]),
  entry("transport Menu", "Import audio", "media.import", [importAudio]),
  entry("transport Menu", "New track", "track.add"),
  entry("transport Menu", "Remove track", "track.remove"),
  entry("transport Menu", "Move track up", "track.moveUp"),
  entry("transport Menu", "Move track down", "track.moveDown"),
  entry("transport Menu", "Add chapter", "edit.addChapter"),
  entry("transport Menu", "Refresh mix", "render.refreshMix", [refreshMixRow]),
  entry("transport Menu", "Export diagnostics", "help.diagnosticsBundle", [
    projectMenuRow("Help", "help.diagnosticsBundle"),
  ]),
  // The palette never lists itself, and audition takes a mode argument.
  component("transport Menu", "Commands and shortcuts", [headerPalette]),
  component("transport Menu", "Audition (Full mix, Edited, Raw)", [
    auditionMenu,
  ]),
  component("transport Menu", "People and Follow", [peopleSlot]),
  component("transport Menu", "Theme", [themeRow]),

  component("View menu", "Layers", [viewLayers]),
  entry("View menu", "Waveform zoom in", "view.waveformZoomIn", [
    viewSheetButton("Waveform amplitude", 1, "view.waveformZoomIn"),
  ]),
  entry("View menu", "Waveform zoom out", "view.waveformZoomOut", [
    viewSheetButton("Waveform amplitude", 0, "view.waveformZoomOut"),
  ]),
  entry("View menu", "Zoom in", "view.zoomIn", [
    cornerButton("Zoom in", "view.zoomIn"),
  ]),
  entry("View menu", "Zoom out", "view.zoomOut", [
    cornerButton("Zoom out", "view.zoomOut"),
  ]),
  entry("View menu", "Fit", "view.fit", [
    cornerButton("Fit session width", "view.fit"),
  ]),
  entry("View menu", "Track height smaller", "view.trackHeightDecrease", [
    viewSheetButton("Track height", 0, "view.trackHeightDecrease"),
  ]),
  entry("View menu", "Track height larger", "view.trackHeightIncrease", [
    viewSheetButton("Track height", 1, "view.trackHeightIncrease"),
  ]),
  entry("View menu", "Fit tracks to window", "view.fitTracksHeight", [
    fitTracksHeight,
  ]),

  // Layout presets: Default, Timeline, Text, Review become Script toggles.
  entry(
    "layout presets",
    "Timeline only / Restore layout",
    "view.toggleScript",
    [cornerButton("Show or hide Script", "view.toggleScript")],
  ),
  entry("layout presets", "Text only", "view.scriptFocus"),
  entry("layout presets", "Review layout", "stage.review"),

  component("More hub", "Command search", [headerPalette]),
  component("More hub", "Mix", [mixSheet]),
  component("More hub", "Comments", [
    reviewSection(/Comments/, "comments panel"),
  ]),
  component("More hub", "Impact", [reviewSection(/Impact/, "impact panel")]),
  component("More hub", "Tighten", [reviewSection(/Tighten/, "tighten panel")]),
  component("More hub", "Pipeline", [pipeline]),
  entry("More hub", "History", "edit.history", [historySheet]),
  entry("More hub", "Import audio", "media.import"),
  entry("More hub", "New track", "track.add"),
  entry("More hub", "Add chapter", "edit.addChapter", [
    plusMenuRow(/Add chapter at playhead/, "edit.addChapter"),
  ]),
  component("More hub", "Gestures", [gesturesButton]),
  component("More hub", "Home-screen hint", [homeScreenHint]),
  component("More hub", "People", [peopleSlot]),

  // Tool rail and the transport bar's own tool buttons.
  entry("tool rail", "Select tool", "tool.select", [
    toolStripButton("Select tool", "tool.select"),
  ]),
  entry("tool rail", "Blade tool", "tool.blade", [
    toolStripButton("Blade tool", "tool.blade"),
  ]),
  entry("tool rail", "Comment mode", "review.toggleCommentMode", [
    toolStripButton("Toggle comment mode", "review.toggleCommentMode"),
  ]),
  entry("tool rail", "Select a range", "range.arm", [
    toolStripButton("Select range", "range.arm"),
  ]),
  entry("tool rail", "Cut at playhead", "edit.bladeCut"),
  entry("transport bar", "Add track", "track.add", [
    plusMenuRow(/New track/, "track.add"),
  ]),
];

describe("palette coverage of the removed menus", () => {
  let paletteIds: Set<string>;

  beforeEach(() => {
    stubViewportShell("desktop");
    registerDawCommands();
    useRecordHostStore.setState({ snapshot: null });
    useDawStore
      .getState()
      .hydrate(
        "/tmp/palette-coverage.json",
        minimalProject({ tracks: [sampleTrack()] }),
      );
    paletteIds = new Set(
      paletteCommands(buildCommandContext()).map((row) => row.id),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ["standalone", "maxTouchPoints"]) {
      Reflect.deleteProperty(navigator, key);
    }
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  });

  const commands = REMOVED_SURFACES.filter((e) => e.command);
  const homes = REMOVED_SURFACES.filter((e) => e.home);

  it.each(commands.map((e) => [e.surface, e.label, e.command] as const))(
    "%s: %s is still a catalog command the palette lists (%s)",
    (_surface, _label, id) => {
      expect(COMMANDS[id as string], `${id} left the catalog`).toBeDefined();
      expect(COMMANDS[id as string].paletteRunnable).not.toBe(false);
      expect(paletteIds.has(id as string), `${id} is not in the palette`).toBe(
        true,
      );
    },
  );

  it.each(homes.map((e) => [e.surface, e.label, e.home] as const))(
    "%s: %s has its new home on screen",
    async (_surface, _label, home) => {
      for (const probe of home ?? []) {
        const user = userEvent.setup();
        await probe(user);
        // One home per mount: the next probe starts from an empty document.
        cleanup();
        registerDawCommands();
      }
    },
  );

  it("covers a command once per surface at most", () => {
    const seen = new Set<string>();
    for (const e of REMOVED_SURFACES) {
      const key = `${e.surface}|${e.label}`;
      expect(seen.has(key), `${key} is listed twice`).toBe(false);
      seen.add(key);
    }
  });
});
