import { beforeEach, describe, expect, it } from "vitest";
import { matchKeymapCommands } from "../keymap/registry";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { StageId } from "../types/stage";
import { COMMANDS } from "./catalog";
import { buildCommandContext, evaluateWhen } from "./context";

const KEYS = [
  { label: "Backspace", key: "Backspace", ctrlKey: false },
  { label: "Delete", key: "Delete", ctrlKey: false },
  { label: "Mod+K", key: "k", ctrlKey: true },
  { label: "Mod+X", key: "x", ctrlKey: true },
  { label: "Mod+Backspace", key: "Backspace", ctrlKey: true },
  { label: "Mod+V", key: "v", ctrlKey: true },
] as const;

function enabledEditCommands(key: (typeof KEYS)[number]): string[] {
  const ctx = buildCommandContext();
  return matchKeymapCommands(
    {
      key: key.key,
      code: key.key,
      metaKey: false,
      ctrlKey: key.ctrlKey,
      altKey: false,
      shiftKey: false,
    },
    false,
  )
    .filter((cmd) => cmd.id.startsWith("edit."))
    .filter((cmd) => evaluateWhen(COMMANDS[cmd.id].when, ctx).ok)
    .map((cmd) => cmd.id);
}

beforeEach(() => {
  useDawStore
    .getState()
    .hydrate(
      "/tmp/stage-keys.json",
      minimalProject({ tracks: [sampleTrack()] }),
    );
  useDawStore.setState({
    selection: { kind: "clip", id: "c1", trackId: "host" } as never,
    stage: "edit",
    timelineFocused: true,
  });
});

describe("edit keys follow the stage", () => {
  it("runs on Edit", () => {
    for (const key of KEYS) {
      expect(enabledEditCommands(key), key.label).not.toEqual([]);
    }
  });

  it.each(["prepare", "review", "deliver", "record"] as StageId[])(
    "does nothing on %s with a clip still selected, and works again back on Edit",
    (stage) => {
      const selection = useDawStore.getState().selection;
      useDawStore.getState().openStage(stage);
      // Clicking the header or Player sets this on any stage.
      useDawStore.getState().setTimelineFocused(true);
      expect(useDawStore.getState().selection).toBe(selection);
      expect(buildCommandContext().stage).toBe(stage);
      for (const key of KEYS) {
        expect(enabledEditCommands(key), `${key.label} on ${stage}`).toEqual(
          [],
        );
      }
      useDawStore.getState().openStage("edit");
      for (const key of KEYS) {
        expect(
          enabledEditCommands(key),
          `${key.label} back on Edit`,
        ).not.toEqual([]);
      }
    },
  );
});

const TRACK_KEYS = ["Delete", "Backspace", "ArrowUp", "ArrowDown"] as const;

function enabledTrackCommands(key: string): string[] {
  const ctx = buildCommandContext();
  return matchKeymapCommands(
    {
      key,
      code: key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    },
    false,
  )
    .filter((cmd) => cmd.id.startsWith("track."))
    .filter((cmd) => evaluateWhen(COMMANDS[cmd.id].when, ctx).ok)
    .map((cmd) => cmd.id);
}

describe("track keys follow the stage", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate(
      "/tmp/stage-keys.json",
      minimalProject({
        tracks: [
          sampleTrack({ id: "a" }),
          sampleTrack({ id: "b" }),
          sampleTrack({ id: "c" }),
        ],
      }),
    );
    useDawStore.setState({
      selection: { kind: "track", trackId: "b" } as never,
      stage: "edit",
    });
  });

  it("runs on Edit", () => {
    for (const key of TRACK_KEYS) {
      expect(enabledTrackCommands(key), key).not.toEqual([]);
    }
  });

  it.each(["prepare", "review", "deliver", "record"] as StageId[])(
    "does nothing on %s with a track still selected, and works again back on Edit",
    (stage) => {
      const selection = useDawStore.getState().selection;
      useDawStore.getState().openStage(stage);
      expect(useDawStore.getState().selection).toBe(selection);
      expect(buildCommandContext().stage).toBe(stage);
      for (const key of TRACK_KEYS) {
        expect(enabledTrackCommands(key), `${key} on ${stage}`).toEqual([]);
      }
      useDawStore.getState().openStage("edit");
      for (const key of TRACK_KEYS) {
        expect(enabledTrackCommands(key), `${key} back on Edit`).not.toEqual(
          [],
        );
      }
    },
  );
});
