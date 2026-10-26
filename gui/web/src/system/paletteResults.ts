import type { SystemIconName } from "./icons";
import type { KeySpec } from "./verbs";

export type PaletteGroup =
  | "Commands"
  | "Stages"
  | "Projects"
  | "People"
  | "Chapters"
  | "Gestures"
  | "Help";

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  icon?: SystemIconName | null;
  context?: string;
  keys?: readonly KeySpec[];
};

const GROUP_ORDER: readonly PaletteGroup[] = [
  "Commands",
  "Stages",
  "Projects",
  "People",
  "Chapters",
  "Gestures",
  "Help",
];

function matches(item: PaletteItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" ||
    `${item.label} ${item.context ?? ""}`.toLowerCase().includes(needle)
  );
}

export type ResultGroup = { name: string; items: PaletteItem[] };

/**
 * The groups to show. An empty query with recent ids that still exist shows
 * only Recent; if none of them exists any more it shows every group, so the
 * palette never opens on an empty Recent and "No matches".
 */
export function resultGroups(
  items: readonly PaletteItem[],
  query: string,
  recent: readonly string[] = [],
): ResultGroup[] {
  if (query.trim() === "" && recent.length > 0) {
    const found = recent
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is PaletteItem => item !== undefined);
    if (found.length > 0) return [{ name: "Recent", items: found }];
  }
  return GROUP_ORDER.map((name) => ({
    name,
    items: items.filter((item) => item.group === name && matches(item, query)),
  })).filter((group) => group.items.length > 0);
}
