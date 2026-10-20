/**
 * Keymap dispatch order is declared per shared key (#1795). Two rows on one
 * key run in the order `SHARED_KEY_ORDER` states, not in whatever order the
 * catalog lists them: a row added above another, or a new row on a taken key,
 * changes what Backspace, Escape or M does, so this fails until the order is
 * written down.
 */
import { describe, expect, it } from "vitest";
import {
  KEYMAP_COMMANDS,
  type KeymapCommand,
  matchKeymapCommands,
  SHARED_KEY_ORDER,
} from "./registry";

function modifierPrefix(cmd: KeymapCommand): string {
  if (cmd.requireAlt) return "Alt+";
  if (cmd.requireMod) return "Mod+";
  return "";
}

function shiftsOverlap(a: KeymapCommand, b: KeymapCommand): boolean {
  return (
    a.requireShift === undefined ||
    b.requireShift === undefined ||
    a.requireShift === b.requireShift
  );
}

/** Keys two or more rows can match at once, with the rows in catalog order. */
function sharedKeys(): Map<string, string[]> {
  const rowsByKey = new Map<string, KeymapCommand[]>();
  for (const cmd of KEYMAP_COMMANDS) {
    for (const key of cmd.keys) {
      const chord = `${modifierPrefix(cmd)}${key}`.toUpperCase();
      rowsByKey.set(chord, [...(rowsByKey.get(chord) ?? []), cmd]);
    }
  }
  const shared = new Map<string, string[]>();
  for (const [chord, rows] of rowsByKey) {
    const overlapping = rows.filter((row) =>
      rows.some((other) => other !== row && shiftsOverlap(row, other)),
    );
    if (overlapping.length > 1) {
      shared.set(
        chord,
        overlapping.map((row) => row.id),
      );
    }
  }
  return shared;
}

function eventFor(key: string) {
  const mod = key.startsWith("Mod+");
  const bare = key.replace(/^(Mod|Alt)\+/, "");
  return {
    key: bare.length === 1 ? bare.toLowerCase() : bare,
    code: "",
    metaKey: false,
    ctrlKey: mod,
    altKey: key.startsWith("Alt+"),
    shiftKey: false,
  };
}

describe("shared key order", () => {
  it("declares every key that more than one row can match", () => {
    const declared = new Map(
      SHARED_KEY_ORDER.map(({ key, order }) => [key.toUpperCase(), order]),
    );
    expect(SHARED_KEY_ORDER.length).toBe(declared.size);
    const shared = sharedKeys();
    expect([...declared.keys()].sort()).toEqual([...shared.keys()].sort());
    for (const [chord, ids] of shared) {
      expect([...(declared.get(chord) ?? [])].sort(), chord).toEqual(
        [...ids].sort(),
      );
    }
  });

  it("gives each declared key a reason", () => {
    for (const { key, why } of SHARED_KEY_ORDER) {
      expect(why.length, key).toBeGreaterThan(20);
    }
  });

  it("dispatches the rows of a shared key in the declared order", () => {
    for (const { key, order } of SHARED_KEY_ORDER) {
      const matched = matchKeymapCommands(eventFor(key), false).map(
        (cmd) => cmd.id,
      );
      expect(matched, key).toEqual(order);
    }
  });
});
