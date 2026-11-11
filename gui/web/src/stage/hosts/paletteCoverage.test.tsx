import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRecentProjects } from "../../api";
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
import { presenceProjectInitial } from "../../state/presenceSlice";
import { DawProvider } from "../../state/store";
import { fakeExportServer } from "../../test/fakeExportServer";
import {
  minimalProject,
  sampleComment,
  sampleTrack,
  sessionRoster,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { CommandPalette } from "../dialogs/CommandPalette";
import { paletteCommands } from "../dialogs/commandPaletteRows";
import { EditCorner } from "../edit/EditCorner";
import { EDIT_SHEETS } from "../edit/editSheets";
import { PlusMenu } from "../edit/PlusMenu";
import { PlayerBar } from "../frame/PlayerBar";
import { StageFrame } from "../frame/StageFrame";
import { BounceFlowProvider } from "./bounceFlow";
import { ExportFlowProvider } from "./exportFlow";
import { StageHost } from "./StageHost";
import { ShareFlowProvider } from "./shareFlow";

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
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listRecentProjects: vi.fn(async () => []),
}));
vi.mock("../edit/EditWorkspace", () => ({
  EditWorkspace: () => <div>edit workspace</div>,
}));

const HOST_PATH = "/tmp/palette-coverage/episode.sharecut";

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
      {() => (
        <>
          <p>stage body</p>
        </>
      )}
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
      <ExportFlowProvider>
        <BounceFlowProvider>
          <ShareFlowProvider>
            <StageHost />
          </ShareFlowProvider>
        </BounceFlowProvider>
      </ExportFlowProvider>
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

/** A person's face in the header opens a menu whose Follow row follows them. */
const peopleSlot: Probe = async (user) => {
  mountFrame();
  await user.click(button(/^Maya/));
  await runs("presence.follow", () =>
    user.click(screen.getByRole("menuitem", { name: "Follow" })),
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

const gesturesRows: Probe = async () => {
  asHost("edit");
  useDawStore.setState({ pointerKind: "coarse" });
  useDawStore.getState().setCommandPaletteOpen(true);
  render(
    <DawProvider projectPath={HOST_PATH} initialProject={minimalProject()}>
      <CommandPalette />
    </DawProvider>,
  );
  expect(
    within(screen.getByRole("group", { name: "Gestures" })).getAllByRole(
      "listitem",
    ),
  ).toHaveLength(5);
};

const exportButton: Probe = async (user) => {
  const exportServer = fakeExportServer();
  mountStage("deliver");
  const press = await screen.findByRole("button", { name: "Export" });
  await waitFor(() => expect(press).toBeEnabled());
  await user.click(press);
  await waitFor(() =>
    expect(
      exportServer.exportRequests,
      "Export did not start a job",
    ).toHaveLength(1),
  );
};

const bounceButton: Probe = async (user) => {
  const bounceServer = fakeExportServer();
  mountStage("deliver");
  await user.click(await screen.findByRole("button", { name: "Bounce" }));
  await waitFor(() =>
    expect(
      bounceServer.bounceRequests,
      "Bounce did not start a job",
    ).toHaveLength(1),
  );
};

const refreshMixRow: Probe = async (user) => {
  asHost("deliver");
  useDawStore.getState().setProject(staleProject());
  render(
    <ExportFlowProvider>
      <BounceFlowProvider>
        <ShareFlowProvider>
          <StageHost />
        </ShareFlowProvider>
      </BounceFlowProvider>
    </ExportFlowProvider>,
  );
  await runs("render.refreshMix", () =>
    user.click(screen.getByRole("button", { name: "Refresh mix" })),
  );
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

const queueOnScreen: Probe = async () => {
  mountStage("review");
  expect(screen.getAllByText("Nothing to decide")[0]).toBeInTheDocument();
  expect(screen.queryByRole("tablist", { name: "Review sections" })).toBeNull();
};

const commentsInQueue: Probe = async () => {
  mountStage("review");
  act(() =>
    useDawStore.setState({
      project: minimalProject({
        tracks: [sampleTrack()],
        comments: [sampleComment({ body: "Lose the cough" })],
      }),
    }),
  );
  expect(
    within(screen.getByRole("region", { name: "Comments" })).getByText(
      "Lose the cough",
    ),
  ).toBeInTheDocument();
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

const touchRangeToggle: Probe = async (user) => {
  asHost("edit");
  useDawStore.setState({ pointerKind: "coarse" });
  render(<EditCorner />);
  await runs("range.arm", () => user.click(button("Select range")));
  useDawStore.setState({ pointerKind: "fine" });
};

/** The eye opens the View popover: layer chips and the amplitude scrub field. */
const eyePopover: Probe = async (user) => {
  asHost("edit");
  render(<EditCorner />);
  await user.click(button("View options"));
  const popover = screen.getByRole("dialog", { name: "View options" });
  const layers = within(popover).getByRole("group", {
    name: "Display options",
  });
  expect(
    within(layers).getByRole("button", { name: "Volume envelope" }),
  ).toBeInTheDocument();
  expect(
    within(popover).getByRole("spinbutton", { name: "Waveform amplitude" }),
  ).toBeInTheDocument();
};

const REMOVED_SURFACES: Entry[] = [
  // Transport Menu: Timeline tools, Project, Media, Markers, Selection, Help.
  entry("transport Menu", "Select a range", "range.arm"),
  entry("transport Menu", "Cut at playhead", "edit.bladeCut"),
  entry("transport Menu", "New project", "project.new"),
  entry("transport Menu", "Open project", "project.open"),
  entry("transport Menu", "Bounce", "export.bounce", [bounceButton]),
  entry("transport Menu", "Export deliverables", "export.deliverables", [
    exportButton,
  ]),
  entry("transport Menu", "Share", "share.manage", [headerInvite]),
  entry("transport Menu", "Record room", "stage.record", [
    plusMenuRow(/^Record here/, "stage.record"),
  ]),
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
  entry("transport Menu", "Report a problem", "help.diagnosticsBundle"),
  // The palette never lists itself, and audition takes a mode argument.
  component("transport Menu", "Commands and shortcuts", [headerPalette]),
  component("transport Menu", "Audition (Full mix, Edited, Raw)", [
    auditionMenu,
  ]),
  component("transport Menu", "People and Follow", [peopleSlot]),
  component("transport Menu", "Theme", [themeRow]),

  component("View menu", "Layers and Waveform amplitude", [eyePopover]),
  // Amplitude is the popover's scrub field, Shift+Up and Shift+Down.
  entry("View menu", "Waveform zoom in", "view.waveformZoomIn"),
  entry("View menu", "Waveform zoom out", "view.waveformZoomOut"),
  entry("View menu", "Zoom in", "view.zoomIn", [
    cornerButton("Zoom in", "view.zoomIn"),
  ]),
  entry("View menu", "Zoom out", "view.zoomOut", [
    cornerButton("Zoom out", "view.zoomOut"),
  ]),
  entry("View menu", "Fit", "view.fit", [
    cornerButton("Fit session width", "view.fit"),
  ]),
  // Track height is Alt+= and Alt+-; Fit is the default (fit tracks: palette).
  entry("View menu", "Track height smaller", "view.trackHeightDecrease"),
  entry("View menu", "Track height larger", "view.trackHeightIncrease"),
  entry("View menu", "Fit tracks to window", "view.fitTracksHeight"),

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
  component("More hub", "Comments", [commentsInQueue]),
  component("More hub", "Queue", [queueOnScreen]),
  component("More hub", "Pipeline", [pipeline]),
  entry("More hub", "History", "edit.history", [historySheet]),
  entry("More hub", "Import audio", "media.import"),
  entry("More hub", "New track", "track.add"),
  entry("More hub", "Add chapter", "edit.addChapter", [
    plusMenuRow(/Add chapter at playhead/, "edit.addChapter"),
  ]),
  component("More hub", "Gestures", [gesturesRows]),
  component("More hub", "People", [peopleSlot]),

  // Tool rail and the transport bar's own tool buttons.
  // Comment mode is gone; Comment arrives as a verb (C) with the action bar.
  entry("tool rail", "Select a range", "range.arm", [touchRangeToggle]),
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
    vi.mocked(listRecentProjects).mockReset();
    vi.mocked(listRecentProjects).mockResolvedValue([]);
    useDawStore.setState(presenceProjectInitial());
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
