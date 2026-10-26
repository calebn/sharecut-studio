import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../../commands/catalog";
import { buildCommandContext } from "../../commands/context";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { SRC_ROOT } from "../../test/sourceFiles";
import { paletteCommands } from "../dialogs/commandPaletteRows";

/**
 * Arena decision 6: every command that was reachable from the transport Menu,
 * the View menu, the layout presets, the phone More hub or the tool rail is
 * still a catalog command the palette lists, or its new home component is
 * there and mounted. A removed menu can never take a capability with it.
 *
 * The table is written from architect-sonnet.md section 1.2 (MENU-MAIN). The
 * old sources are deleted, so the table stands alone.
 */

type Surface =
  | "transport Menu"
  | "View menu"
  | "layout presets"
  | "More hub"
  | "tool rail"
  | "transport bar";

type Entry = {
  surface: Surface;
  /** What the person saw. */
  label: string;
  /** Still a catalog command, listed by the palette. */
  command?: string;
  /** Source text, relative to src/, that must still contain `needle`. */
  home?: { file: string; needle: string }[];
};

const entry = (
  surface: Surface,
  label: string,
  command: string,
  home?: Entry["home"],
): Entry => ({ surface, label, command, home });

const component = (
  surface: Surface,
  label: string,
  home: NonNullable<Entry["home"]>,
): Entry => ({ surface, label, home });

const REMOVED_SURFACES: Entry[] = [
  // Transport Menu: Timeline tools, Project, Media, Markers, Selection, Help.
  entry("transport Menu", "Select tool", "tool.select"),
  entry("transport Menu", "Blade tool", "tool.blade"),
  entry("transport Menu", "Select a range", "range.arm"),
  entry("transport Menu", "Cut at playhead", "edit.bladeCut"),
  entry("transport Menu", "New project", "project.new"),
  entry("transport Menu", "Open project", "project.open"),
  entry("transport Menu", "Bounce", "export.bounce", [
    { file: "stage/hosts/DeliverStage.tsx", needle: "export.bounce" },
  ]),
  entry("transport Menu", "Export deliverables", "export.deliverables", [
    { file: "stage/hosts/DeliverStage.tsx", needle: "export.deliverables" },
  ]),
  entry("transport Menu", "Share", "share.manage", [
    { file: "stage/hosts/DeliverStage.tsx", needle: "share.manage" },
    { file: "stage/frame/useHeaderProps.ts", needle: "share.manage" },
  ]),
  entry("transport Menu", "Record room", "record.openPanel", [
    { file: "stage/hosts/RecordStage.tsx", needle: "record.openPanel" },
  ]),
  entry("transport Menu", "Connect agent", "mcp.connect", [
    { file: "stage/frame/useHeaderProps.ts", needle: "mcp.connect" },
  ]),
  entry("transport Menu", "Import audio", "media.import", [
    { file: "stage/hosts/PrepareStage.tsx", needle: "media.import" },
  ]),
  entry("transport Menu", "New track", "track.add"),
  entry("transport Menu", "Remove track", "track.remove"),
  entry("transport Menu", "Move track up", "track.moveUp"),
  entry("transport Menu", "Move track down", "track.moveDown"),
  entry("transport Menu", "Add chapter", "edit.addChapter"),
  entry("transport Menu", "Refresh mix", "render.refreshMix", [
    { file: "stage/hosts/DeliverStage.tsx", needle: "render.refreshMix" },
  ]),
  entry("transport Menu", "Export diagnostics", "help.diagnosticsBundle", [
    { file: "stage/frame/useHeaderProps.ts", needle: "help.diagnosticsBundle" },
  ]),
  // The palette never lists itself, and audition takes a mode argument.
  component("transport Menu", "Commands and shortcuts", [
    {
      file: "stage/frame/useHeaderProps.ts",
      needle: "ui.toggleCommandPalette",
    },
  ]),
  component("transport Menu", "Audition (Full mix, Edited, Raw)", [
    { file: "stage/frame/usePlayerProps.ts", needle: "hearMenu" },
    { file: "system/Player.tsx", needle: "hearMenu" },
  ]),
  component("transport Menu", "People and Follow", [
    { file: "stage/frame/HeaderPeople.tsx", needle: "AvatarStack" },
    { file: "stage/frame/StageFrame.tsx", needle: "HeaderPeople" },
  ]),
  component("transport Menu", "Theme", [
    { file: "system/AppHeader.tsx", needle: "appearance" },
    { file: "stage/frame/useHeaderProps.ts", needle: "useTheme" },
  ]),

  // View menu.
  component("View menu", "Layers", [
    { file: "stage/edit/ViewSheet.tsx", needle: "OverlayLegend" },
    { file: "stage/edit/editSheets.tsx", needle: "ViewSheet" },
  ]),
  entry("View menu", "Waveform zoom in", "view.waveformZoomIn", [
    { file: "stage/edit/ViewSheet.tsx", needle: "view.waveformZoomIn" },
  ]),
  entry("View menu", "Waveform zoom out", "view.waveformZoomOut", [
    { file: "stage/edit/ViewSheet.tsx", needle: "view.waveformZoomOut" },
  ]),
  entry("View menu", "Zoom in", "view.zoomIn", [
    { file: "stage/edit/EditCornerView.tsx", needle: "view.zoomIn" },
  ]),
  entry("View menu", "Zoom out", "view.zoomOut", [
    { file: "stage/edit/EditCornerView.tsx", needle: "view.zoomOut" },
  ]),
  entry("View menu", "Fit", "view.fit", [
    { file: "stage/edit/EditCorner.tsx", needle: "view.fit" },
  ]),
  entry("View menu", "Track height smaller", "view.trackHeightDecrease", [
    { file: "stage/edit/ViewSheet.tsx", needle: "view.trackHeightDecrease" },
  ]),
  entry("View menu", "Track height larger", "view.trackHeightIncrease", [
    { file: "stage/edit/ViewSheet.tsx", needle: "view.trackHeightIncrease" },
  ]),
  entry("View menu", "Fit tracks to window", "view.fitTracksHeight", [
    { file: "stage/edit/ViewSheet.tsx", needle: "view.fitTracksHeight" },
  ]),

  // Layout presets: Default, Timeline, Text, Review become Script toggles.
  entry(
    "layout presets",
    "Timeline only / Restore layout",
    "view.toggleScript",
    [{ file: "stage/edit/EditCorner.tsx", needle: "view.toggleScript" }],
  ),
  entry("layout presets", "Text only", "view.scriptFocus"),
  entry("layout presets", "Review layout", "stage.review"),

  // Phone More hub.
  component("More hub", "Command search", [
    {
      file: "stage/frame/useHeaderProps.ts",
      needle: "ui.toggleCommandPalette",
    },
  ]),
  component("More hub", "Mix", [
    { file: "stage/edit/editSheets.tsx", needle: "TrackMix" },
    { file: "stage/edit/EditWorkspace.tsx", needle: '"mix"' },
  ]),
  component("More hub", "Comments", [
    { file: "stage/hosts/ReviewStage.tsx", needle: "CommentsPanel" },
  ]),
  component("More hub", "Impact", [
    { file: "stage/hosts/ReviewStage.tsx", needle: "ImpactPanel" },
  ]),
  component("More hub", "Tighten", [
    { file: "stage/hosts/ReviewStage.tsx", needle: "TightenPanel" },
  ]),
  component("More hub", "Pipeline", [
    { file: "stage/hosts/PrepareStage.tsx", needle: "PipelinePanel" },
  ]),
  component("More hub", "History", [
    { file: "stage/frame/SheetHost.tsx", needle: "HistoryPanel" },
  ]),
  entry("More hub", "Import audio", "media.import"),
  entry("More hub", "New track", "track.add"),
  entry("More hub", "Add chapter", "edit.addChapter", [
    { file: "stage/edit/PlusMenu.tsx", needle: "edit.addChapter" },
  ]),
  component("More hub", "Gestures", [
    { file: "stage/dialogs/CommandPaletteView.tsx", needle: "onOpenGestures" },
  ]),
  component("More hub", "Home-screen hint", [
    { file: "stage/frame/BannerStack.tsx", needle: "HomeScreenHint" },
  ]),
  component("More hub", "People", [
    { file: "stage/frame/HeaderPeople.tsx", needle: "AvatarStack" },
  ]),

  // Tool rail and the transport bar's own tool buttons.
  entry("tool rail", "Select tool", "tool.select", [
    { file: "stage/edit/ToolModeToggle.tsx", needle: "tool.select" },
    { file: "stage/edit/EditToolStrip.tsx", needle: "ToolModeToggle" },
  ]),
  entry("tool rail", "Blade tool", "tool.blade", [
    { file: "stage/edit/ToolModeToggle.tsx", needle: "tool.blade" },
    { file: "stage/edit/EditToolStrip.tsx", needle: "ToolModeToggle" },
  ]),
  entry("tool rail", "Comment mode", "review.toggleCommentMode", [
    {
      file: "stage/edit/ToolModeToggle.tsx",
      needle: "review.toggleCommentMode",
    },
    { file: "stage/edit/EditToolStrip.tsx", needle: "ToolModeToggle" },
  ]),
  entry("tool rail", "Select a range", "range.arm", [
    { file: "stage/edit/EditToolStrip.tsx", needle: "range.arm" },
  ]),
  entry("tool rail", "Cut at playhead", "edit.bladeCut"),
  entry("transport bar", "Add track", "track.add", [
    { file: "stage/edit/PlusMenu.tsx", needle: "track.add" },
  ]),
];

const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), "utf8");

describe("palette coverage of the removed menus", () => {
  let paletteIds: Set<string>;

  beforeEach(() => {
    registerDawCommands();
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
    "%s: %s has its new home referenced",
    (_surface, _label, home) => {
      for (const { file, needle } of home ?? []) {
        expect(existsSync(join(SRC_ROOT, file)), `${file} is missing`).toBe(
          true,
        );
        expect(read(file), `${file} no longer references ${needle}`).toContain(
          needle,
        );
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
