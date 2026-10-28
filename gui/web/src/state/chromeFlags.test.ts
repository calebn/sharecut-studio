import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

const FLAGS = [
  "commandPaletteOpen",
  "gesturesSheetOpen",
  "bounceDialogOpen",
  "exportRequested",
  "shareDialogOpen",
  "hostMcpDialogOpen",
  "helpDialogOpen",
  "modelsDialogOpen",
  "transcriptFindReplaceOpen",
] as const;
type Flag = (typeof FLAGS)[number];

const SETTERS: Record<Flag, string> = {
  commandPaletteOpen: "setCommandPaletteOpen",
  gesturesSheetOpen: "setGesturesSheetOpen",
  bounceDialogOpen: "setBounceDialogOpen",
  exportRequested: "setExportRequested",
  shareDialogOpen: "setShareDialogOpen",
  hostMcpDialogOpen: "setHostMcpDialogOpen",
  helpDialogOpen: "setHelpDialogOpen",
  modelsDialogOpen: "setModelsDialogOpen",
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

  it("closing the bounce dialog clears its range target; opening keeps it", () => {
    const s = () => useDawStore.getState();
    const target = { startSec: 1, endSec: 2 } as never;
    s().setBounceRangeTarget(target);
    s().setBounceDialogOpen(true);
    expect(s().bounceRangeTarget).toBe(target);
    s().setBounceDialogOpen(false);
    expect(s().bounceRangeTarget).toBeNull();
  });

  describe("hydrate", () => {
    const OTHER = [
      "commandPaletteOpen",
      "gesturesSheetOpen",
      "shareDialogOpen",
      "hostMcpDialogOpen",
      "helpDialogOpen",
    ] as const;

    function openEverything() {
      for (const f of FLAGS) setFlag(f, true);
    }

    it("keeps every flag open when the project path is unchanged", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      expect(read("transcriptFindReplaceOpen")).toBe(true);
      expect(read("bounceDialogOpen")).toBe(true);
      expect(read("exportRequested")).toBe(true);
      for (const f of OTHER) expect(read(f)).toBe(true);
    });

    it("closes find/replace on a path change and leaves the untouched six open", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      expect(read("transcriptFindReplaceOpen")).toBe(false);
      for (const f of OTHER) expect(read(f)).toBe(true);
    });

    it("closes the bounce dialog and drops a pending export request when the project switches", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      expect(read("bounceDialogOpen")).toBe(false);
      expect(read("exportRequested")).toBe(false);
    });
  });
});
