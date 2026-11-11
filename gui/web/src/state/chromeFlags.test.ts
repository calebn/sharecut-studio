import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

const FLAGS = [
  "commandPaletteOpen",
  "exportRequested",
  "transcriptRequested",
  "hostMcpDialogOpen",
  "helpDialogOpen",
  "modelsSheetOpen",
  "transcriptFindReplaceOpen",
] as const;
type Flag = (typeof FLAGS)[number];

const SETTERS: Record<Flag, string> = {
  commandPaletteOpen: "setCommandPaletteOpen",
  exportRequested: "setExportRequested",
  transcriptRequested: "setTranscriptRequested",
  hostMcpDialogOpen: "setHostMcpDialogOpen",
  helpDialogOpen: "setHelpDialogOpen",
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

  it("toggling the palette opens it, then closes it", () => {
    const s = () => useDawStore.getState();
    s().toggleCommandPalette();
    expect(read("commandPaletteOpen")).toBe(true);
    s().toggleCommandPalette();
    expect(read("commandPaletteOpen")).toBe(false);
  });

  describe("hydrate", () => {
    const OTHER = [
      "commandPaletteOpen",
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
      expect(read("exportRequested")).toBe(true);
      expect(read("transcriptRequested")).toBe(true);
      for (const f of OTHER) expect(read(f)).toBe(true);
    });

    it("closes find/replace on a path change and leaves the untouched flags open", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      expect(read("transcriptFindReplaceOpen")).toBe(false);
      for (const f of OTHER) expect(read(f)).toBe(true);
    });

    it("drops a pending export and transcript request when the project switches", () => {
      useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
      openEverything();
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
      expect(read("exportRequested")).toBe(false);
      expect(read("transcriptRequested")).toBe(false);
    });
  });
});
