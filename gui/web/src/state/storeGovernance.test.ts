import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT, srcRelative, walkTsFiles } from "../test/sourceFiles";

/**
 * Whole-store reads: `useDaw()` / `useDawStore()` with no selector, or with an
 * inline arrow identity selector such as `(s) => s`, `(s: DawState) => s`,
 * `(s) => { return s; }`, optionally wrapped in `useShallow(...)` or followed
 * by extra arguments (`(s) => s, shallow`). All subscribe to every store
 * change. A named identity function (`useDaw(identity)`) is not detected.
 */
const WHOLE_STORE_READ =
  /\buseDaw(?:Store)?\(\s*(?:(?:useShallow\(\s*)?\(?\s*(\w+)(?:\s*:\s*[\w.<>[\]]+)?\s*\)?\s*=>\s*(?:\1|\{\s*return\s+\1\s*;?\s*\})\s*\)?\s*(?:,[^)]*)?)?\)/g;

function wholeStoreReads(text: string): number {
  return text.match(WHOLE_STORE_READ)?.length ?? 0;
}

/**
 * Hot fields change every frame (playhead, scroll) or every presence frame.
 * Only leaves select them; handlers read `useDawStore.getState()`.
 */
const HOT_FIELD_READ =
  /\bs\.(playheadSec|scrollLeft|sessionClients|pointerTrackId|bladeHoverSec)\b/g;

/** The app root, shells and timeline rows: none may select a hot field. */
const HOT_FIELD_FREE_FILES = [
  "dawApp.tsx",
  "layout/StudioShell.tsx",
  "layout/MobileShell.tsx",
  "timeline/TimelineView.tsx",
  "timeline/TrackLane.tsx",
  "timeline/ClipBlock.tsx",
];

function hotFieldReads(text: string): string[] {
  return [...text.matchAll(HOT_FIELD_READ)].map((m) => m[0]);
}

function isTestFile(rel: string): boolean {
  return /\.test\.[jt]sx?$/.test(rel);
}

describe("store governance", () => {
  it.each([
    ["const { a } = useDaw();", 1],
    ["const s = useDawStore();", 1],
    ["const s = useDawStore(\n);", 1],
    ["useDaw(); useDawStore();", 2],
    ["const { a } = useDaw((s) => ({ a: s.a }));", 0],
    ["const a = useDawStore((s) => s.a);", 0],
    ["useDawStore.getState();", 0],
    ["const x = myuseDaw();", 0],
    ["const s = useDaw((s) => s);", 1],
    ["const s = useDawStore((state) => state);", 1],
    ["const s = useDaw(s => s);", 1],
    ["const s = useDawStore(\n  (s) => s,\n);", 1],
    ["const a = useDaw((s) => s.a);", 0],
    ["const t = useDaw((s) => t);", 0],
    ["const s = useDaw((s: DawState) => s);", 1],
    ["const s = useDawStore((s) => s, shallow);", 1],
    ["const s = useDawStore(useShallow((s) => s));", 1],
    ["const s = useDawStore(useShallow((s: DawState) => s));", 1],
    ["const s = useDaw((s) => { return s; });", 1],
    ["const a = useDaw((s: DawState) => s.a);", 0],
    ["const a = useDawStore((s) => s.a, shallow);", 0],
    ["const a = useDawStore(useShallow((s) => ({ a: s.a })));", 0],
    ["const a = useDaw((s) => { return s.a; });", 0],
    ["const a = useDawStore((s) => sx);", 0],
  ])("counts whole-store reads in %j", (text, expected) => {
    expect(wholeStoreReads(text)).toBe(expected);
  });

  it("reads the DAW store only through selectors outside tests", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = srcRelative(file);
      if (isTestFile(rel)) {
        continue;
      }
      scanned += 1;
      if (wholeStoreReads(readFileSync(file, "utf8")) > 0) {
        offenders.push(rel);
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it.each([
    ["useDaw((s) => ({ a: s.playheadSec }))", ["s.playheadSec"]],
    ["useDawStore((s) => s.scrollLeft)", ["s.scrollLeft"]],
    [
      "(s) => s.sessionClients.length + s.bladeHoverSec",
      ["s.sessionClients", "s.bladeHoverSec"],
    ],
    ["useDawStore.getState().pointerTrackId", []],
    ["useDawStore((s) => s.playheadSecs)", []],
  ])("finds hot field reads in %j", (text, expected) => {
    expect(hotFieldReads(text)).toEqual(expected);
  });

  it.each(HOT_FIELD_FREE_FILES)("%s selects no hot store field", (rel) => {
    const text = readFileSync(join(SRC_ROOT, rel), "utf8");
    expect(hotFieldReads(text)).toEqual([]);
  });
});
