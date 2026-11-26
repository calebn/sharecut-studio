import type {
  DamagedKitRow,
  KitImportEntry,
  KitImportPreview,
  KitListRow,
  KitRow,
} from "../api";

export function kit(over: Partial<KitRow> = {}): KitRow {
  return {
    id: "show-kit-1a2b3c4d",
    name: "Show Kit",
    version: 1,
    versions: [1],
    entries: 2,
    missing: 0,
    usable: true,
    problem: null,
    ...over,
  };
}

export const HEALTHY: KitRow = kit();

export const MULTI_VERSION: KitRow = kit({
  id: "summer-5c1d0000",
  name: "Summer series",
  version: 3,
  versions: [1, 2, 3],
  entries: 1,
});

export const UNUSABLE: KitRow = kit({
  id: "launch-21bc0000",
  name: "Launch week",
  entries: 3,
  missing: 1,
  usable: false,
  problem:
    "1 segment of this kit is not in the library: entry 2 (Sponsor read at end): that segment can't be found. Import the missing segments, or save the kit again with segments you have.",
});

/** A segment is in the library but cannot be read: usable is false while missing is 0. */
export const UNREADABLE: KitRow = kit({
  id: "bumper-9e4f0000",
  name: "Bumper set",
  entries: 2,
  missing: 0,
  usable: false,
  problem:
    "Entry 1 (Cold open): that segment's file can't be read. Import it again, or save the kit again with segments you have.",
});

export const DAMAGED: DamagedKitRow = {
  id: "old-kit-77de0000",
  damaged: true,
  version: 2,
  usable: false,
  problem: "Version 2 can't be read: kit.json is not valid JSON.",
  code: "kit_invalid",
};

export const LONG_NAME: KitRow = kit({
  id: "long-1",
  name: "A very long kit name that keeps going so the row has to wrap under text zoom without a horizontal scrollbar",
});

export const KITS: KitListRow[] = [HEALTHY, MULTI_VERSION, UNUSABLE, DAMAGED];

export const KIT_TOKEN = "b".repeat(32);

export function importEntry(
  over: Partial<KitImportEntry> = {},
): KitImportEntry {
  return {
    position: 0,
    name: "Cold open",
    kind: "intro",
    duration_sec: 12.4,
    at: "start",
    note: null,
    outcome: "added",
    version: 1,
    ...over,
  };
}

/** A waiting kit file: an intro at the start that is new and an outro at the end that is new. */
export function waitingKit(
  over: Partial<KitImportPreview> = {},
): KitImportPreview {
  return {
    token: KIT_TOKEN,
    name: "Show Kit",
    kit_id: "show-kit-1a2b3c4d",
    outcome: "added",
    version: 1,
    entry_count: 2,
    counts: { added: 2, new_version: 0, unchanged: 0 },
    entries: [
      importEntry(),
      importEntry({
        position: 1,
        name: "Sign off",
        kind: "outro",
        duration_sec: 20,
        at: "end",
      }),
    ],
    ...over,
  };
}

/** Entries in a mix of states, one placed at a time and one with a note. */
export const MIXED_KIT: KitImportPreview = waitingKit({
  outcome: "new_version",
  version: 2,
  entry_count: 3,
  counts: { added: 1, new_version: 1, unchanged: 1 },
  entries: [
    importEntry({ outcome: "unchanged" }),
    importEntry({
      position: 1,
      name: "Sponsor read",
      kind: "sponsor",
      duration_sec: 31,
      at: 80,
      note: "Move to after the first break if the episode is under 20 minutes.",
      outcome: "new_version",
      version: 2,
    }),
    importEntry({
      position: 2,
      name: "Sign off",
      kind: "outro",
      duration_sec: 20,
      at: "end",
    }),
  ],
});

export const UNCHANGED_KIT: KitImportPreview = waitingKit({
  outcome: "unchanged",
  counts: { added: 0, new_version: 0, unchanged: 2 },
  entries: [
    importEntry({ outcome: "unchanged" }),
    importEntry({
      position: 1,
      name: "Sign off",
      kind: "outro",
      at: "end",
      outcome: "unchanged",
    }),
  ],
});

export const KIT_FILE = () =>
  new File(["zip"], "show-kit.sharecutkit", { type: "application/zip" });
