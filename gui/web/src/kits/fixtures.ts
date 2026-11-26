import type { DamagedKitRow, KitListRow, KitRow } from "../api";

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
    "1 segment of this kit is not in the library: entry 2 (Sponsor read at end): segment not found. Import the missing segments, or save the kit again with segments you have.",
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
