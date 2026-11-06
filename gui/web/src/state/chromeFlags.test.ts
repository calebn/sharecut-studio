import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

const FLAGS = [
  "commandPaletteOpen",
  "gesturesSheetOpen",
  "bounceRequested",
  "exportRequested",
  "shareRequested",
  "transcriptRequested",
  "agentSheetOpen",
  "helpSheetOpen",
  "settingsSheetOpen",
  "modelsSheetOpen",
  "transcriptFindReplaceOpen",
] as const;
type Flag = (typeof FLAGS)[number];

const SETTERS: Record<Flag, string> = {
  commandPaletteOpen: "setCommandPaletteOpen",
  gesturesSheetOpen: "setGesturesSheetOpen",
  bounceRequested: "setBounceRequested",
  exportRequested: "setExportRequested",
  shareRequested: "setShareRequested",
  transcriptRequested: "setTranscriptRequested",
  agentSheetOpen: "setAgentSheetOpen",
  helpSheetOpen: "setHelpSheetOpen",
  settingsSheetOpen: "setSettingsSheetOpen",
  modelsSheetOpen: "setModelsSheetOpen",
  transcriptFindReplaceOpen: "setTranscriptFindReplaceOpen",
};

function read(flag: Flag): boolean {
  return useDawStore.getState().chrome[flag];
}

function readAll(): Record<Flag, boolean> {
  return Object.fromEntries(FLAGS.map((f) => [f, read(f)])) as Record<
    Flag,
    boolean
  >;
}

function allClosed(): Record<Flag, boolean> {
  return Object.fromEntries(FLAGS.map((f) => [f, false])) as Record<
    Flag,
    boolean
  >;
}

function setFlag(flag: Flag, open: boolean) {
  setChrome({ [flag]: open });
}

describe("dawStore chrome flags", () => {
  beforeEach(() => {
    for (const f of FLAGS) setFlag(f, false);
    useDawStore.setState({ bounceRangeTarget: null });
  });
  afterEach(() => {
    for (const f of FLAGS) setFlag(f, false);
  });

  it("starts with every flag closed", () => {
    expect(readAll()).toEqual(allClosed());
  });

  it.each(Object.entries(SETTERS))(
    "%s opens and closes through its setter without touching the others",
    (flag, setter) => {
      const call = (open: boolean) =>
        (
          useDawStore.getState() as unknown as Record<
            string,
            (open: boolean) => void
          >
        )[setter](open);
      call(true);
      expect(readAll()).toEqual({ ...allClosed(), [flag]: true });
      call(false);
      expect(readAll()).toEqual(allClosed());
    },
  );

  it("opening the palette closes the gestures sheet, and the reverse", () => {
    const s = () => useDawStore.getState();
    s().setGesturesSheetOpen(true);
    s().setCommandPaletteOpen(true);
    expect(read("gesturesSheetOpen")).toBe(false);
    expect(read("commandPaletteOpen")).toBe(true);
    s().setGesturesSheetOpen(true);
    expect(read("commandPaletteOpen")).toBe(false);
    expect(read("gesturesSheetOpen")).toBe(true);
  });

  it("closing the palette leaves the gestures sheet alone", () => {
    const s = () => useDawStore.getState();
    s().setCommandPaletteOpen(true);
    setFlag("gesturesSheetOpen", true);
    s().setCommandPaletteOpen(false);
    expect(read("gesturesSheetOpen")).toBe(true);
  });

  it("toggling the palette follows the same exclusion", () => {
    const s = () => useDawStore.getState();
    setFlag("gesturesSheetOpen", true);
    s().toggleCommandPalette();
    expect(read("commandPaletteOpen")).toBe(true);
    expect(read("gesturesSheetOpen")).toBe(false);
    setFlag("gesturesSheetOpen", true);
    s().toggleCommandPalette();
    expect(read("commandPaletteOpen")).toBe(false);
    expect(read("gesturesSheetOpen")).toBe(true);
  });

  it("keeps Help, Connect agent and Settings from stacking", () => {
    const s = () => useDawStore.getState();
    s().setHelpSheetOpen(true);
    s().setAgentSheetOpen(true);
    expect(read("helpSheetOpen")).toBe(false);
    expect(read("agentSheetOpen")).toBe(true);
    s().setSettingsSheetOpen(true);
    expect(read("agentSheetOpen")).toBe(false);
    expect(read("settingsSheetOpen")).toBe(true);
    s().setSettingsSheetOpen(false);
    expect(read("settingsSheetOpen")).toBe(false);
  });

  it("closes the app sheets when the Palette opens, whichever way it opens", () => {
    const s = () => useDawStore.getState();
    s().setSettingsSheetOpen(true);
    s().setCommandPaletteOpen(true);
    expect(read("settingsSheetOpen")).toBe(false);
    expect(read("commandPaletteOpen")).toBe(true);
    s().setCommandPaletteOpen(false);
    s().setHelpSheetOpen(true, "report");
    expect(useDawStore.getState().chrome.helpSheetStep).toBe("report");
    s().toggleCommandPalette();
    expect(read("helpSheetOpen")).toBe(false);
    expect(read("commandPaletteOpen")).toBe(true);
  });

  describe("hydrate", () => {
    const OTHER = [
      "commandPaletteOpen",
      "gesturesSheetOpen",
      "agentSheetOpen",
      "helpSheetOpen",
      "settingsSheetOpen",
    ] as const;

    function openEverything() {
      for (const f of FLAGS) setFlag(f, true);
    }

    it("keeps every flag open when the project path is unchanged", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      expect(read("transcriptFindReplaceOpen")).toBe(true);
      expect(read("bounceRequested")).toBe(true);
      expect(read("exportRequested")).toBe(true);
      expect(read("shareRequested")).toBe(true);
      expect(read("transcriptRequested")).toBe(true);
      for (const f of OTHER) expect(read(f)).toBe(true);
    });

    it("closes find/replace on a path change and leaves the untouched five open", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      expect(read("transcriptFindReplaceOpen")).toBe(false);
      for (const f of OTHER) expect(read(f)).toBe(true);
    });

    it("drops a pending bounce, export, share and transcript request when the project switches", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      expect(read("bounceRequested")).toBe(false);
      expect(read("exportRequested")).toBe(false);
      expect(read("shareRequested")).toBe(false);
      expect(read("transcriptRequested")).toBe(false);
    });
  });
});
