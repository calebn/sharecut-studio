import type { KitRow } from "../api";

export function entryCount(row: KitRow): string {
  return row.entries === 1 ? "1 segment" : `${row.entries} segments`;
}

export function kitVersionTag(row: KitRow): string {
  return row.versions.length > 1
    ? `v${row.version} · ${row.versions.length} versions`
    : `v${row.version}`;
}
