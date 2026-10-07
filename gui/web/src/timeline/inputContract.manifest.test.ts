/**
 * The capabilities manifest's touch column (#1096) is the grammar's, not a
 * second hand-kept list: each command's `surfaces.touch` must equal what the
 * input contract, the create menu and the Gestures sheet say runs it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../commands/catalog";
import { MOBILE_GESTURES } from "../commands/gestures";
import { SRC_ROOT } from "../test/sourceFiles";
import {
  CREATE_ENTRIES,
  HIT_KINDS,
  TOUCH_GESTURES,
  type TouchGestureId,
} from "./inputContract";

type Row = { id: string; surfaces: { command?: string; touch?: string[] } };

const read = (path: string) =>
  JSON.parse(readFileSync(join(SRC_ROOT, "../../..", path), "utf-8"));
const ROWS: Row[] = read("contracts/capabilities.manifest.json").capabilities;
const SCHEMA = read("schemas/capabilities.manifest.schema.json");

/** command id → the touch gestures the grammar says run it. */
function derived(): Map<string, Set<TouchGestureId>> {
  const out = new Map<string, Set<TouchGestureId>>();
  const add = (command: string, gesture: TouchGestureId) => {
    const set = out.get(command) ?? new Set<TouchGestureId>();
    set.add(gesture);
    out.set(command, set);
  };
  for (const entry of CREATE_ENTRIES) add(entry.command, "long-press-empty");
  for (const contract of Object.values(HIT_KINDS)) {
    if (!contract.command) continue;
    add(contract.command, "long-press-arm-drag");
    if (contract.nudges.length > 0) add(contract.command, "hold-nudge");
  }
  for (const gesture of MOBILE_GESTURES) {
    if (!("commandIds" in gesture)) continue;
    for (const id of gesture.commandIds) add(id, gesture.touch);
  }
  return out;
}

describe("capabilities manifest touch column", () => {
  it("lists, for each command, exactly the touch gestures the grammar derives", () => {
    const expected = Object.fromEntries(
      [...derived()].map(([command, set]) => [command, [...set].sort()]),
    );
    const listed = Object.fromEntries(
      ROWS.filter((row) => row.surfaces.touch).map((row) => [
        row.surfaces.command,
        [...(row.surfaces.touch ?? [])].sort(),
      ]),
    );
    expect(listed).toEqual(expected);
  });

  it("names only TOUCH_GESTURES, in the schema's enum order", () => {
    expect(
      SCHEMA.$defs.capability.properties.surfaces.properties.touch.items.enum,
    ).toEqual(Object.keys(TOUCH_GESTURES));
  });

  it("routes every create menu entry through a catalog command", () => {
    for (const entry of CREATE_ENTRIES) {
      expect(COMMANDS[entry.command]?.id).toBe(entry.command);
      expect(entry.args({ atTime: 12.5, trackId: "host" })).toMatchObject({
        atTime: 12.5,
      });
    }
  });
});
