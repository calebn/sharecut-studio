import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

const FLAGS = [
  "commandPaletteOpen",
  "gesturesSheetOpen",
  "bounceDialogOpen",
  "exportDialogOpen",
  "shareDialogOpen",
  "recordPanelOpen",
  "hostMcpDialogOpen",
  "helpDialogOpen",
  "transcriptFindReplaceOpen",
] as const;
type Flag = (typeof FLAGS)[number];

const SETTERS: Record<Exclude<Flag, "transcriptFindReplaceOpen">, string> = {
  commandPaletteOpen: "setCommandPaletteOpen",
  gesturesSheetOpen: "setGesturesSheetOpen",
  bounceDialogOpen: "setBounceDialogOpen",
  exportDialogOpen: "setExportDialogOpen",
  shareDialogOpen: "setShareDialogOpen",
  recordPanelOpen: "setRecordPanelOpen",
  hostMcpDialogOpen: "setHostMcpDialogOpen",
  helpDialogOpen: "setHelpDialogOpen",
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

  it("allows the share dialog and record panel open together", () => {
    const s = () => useDawStore.getState();
    s().setShareDialogOpen(true);
    s().setRecordPanelOpen(true);
    expect(read("shareDialogOpen")).toBe(true);
    expect(read("recordPanelOpen")).toBe(true);
  });

  describe("hydrate", () => {
    const OTHER = [
      "commandPaletteOpen",
      "gesturesSheetOpen",
      "shareDialogOpen",
      "recordPanelOpen",
      "hostMcpDialogOpen",
      "helpDialogOpen",
    ] as const;

    function openEverything() {
      for (const f of FLAGS) setFlag(f, true);
    }

    it("keeps the flags it does not own when the project path is unchanged", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      expect(read("transcriptFindReplaceOpen")).toBe(true);
      for (const f of OTHER) expect(read(f)).toBe(true);
    });

    it("closes find/replace on a path change and leaves the untouched six open", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      expect(read("transcriptFindReplaceOpen")).toBe(false);
      for (const f of OTHER) expect(read(f)).toBe(true);
    });

    it("closes the bounce and export dialogs when the project switches", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      expect(read("bounceDialogOpen")).toBe(false);
      expect(read("exportDialogOpen")).toBe(false);
    });
  });
});
