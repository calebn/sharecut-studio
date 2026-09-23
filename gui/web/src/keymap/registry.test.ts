import { describe, expect, it } from "vitest";
import {
  formatShortcutKeys,
  KEYMAP_COMMANDS,
  keymapByCategory,
  keymapCommandById,
  matchKeymapCommand,
  matchKeymapCommands,
} from "./registry";
import { _resetKeymapOverridesForTests, setKeymapOverride } from "./remaps";

function keyEvent(
  partial: Partial<
    Pick<
      KeyboardEvent,
      "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
    >
  >,
) {
  return {
    key: "a",
    code: "KeyA",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("keymap registry", () => {
  it("includes stable command ids for tools and transport", () => {
    const ids = KEYMAP_COMMANDS.map((c) => c.id);
    expect(ids).toContain("tool.select");
    expect(ids).toContain("tool.blade");
    expect(ids).toContain("transport.togglePlay");
    expect(ids).toContain("focus.timeline");
    expect(ids).toContain("history.undo");
  });

  it("formats display keys", () => {
    expect(formatShortcutKeys(keymapCommandById("tool.select")!)).toBe("V");
    expect(formatShortcutKeys(keymapCommandById("tool.blade")!)).toBe("C");
    expect(formatShortcutKeys(keymapCommandById("transport.togglePlay")!)).toBe(
      "Space",
    );
    expect(formatShortcutKeys(keymapCommandById("history.undo")!)).toBe(
      "Mod+Z",
    );
  });

  it("groups by category for cheatsheet consumers", () => {
    const by = keymapByCategory();
    expect(by.tools.map((c) => c.id)).toEqual(["tool.select", "tool.blade"]);
    expect(by.focus).toHaveLength(4);
  });

  it("matches V and C case-insensitively", () => {
    expect(matchKeymapCommand(keyEvent({ key: "v", code: "KeyV" }))?.id).toBe(
      "tool.select",
    );
    expect(matchKeymapCommand(keyEvent({ key: "C", code: "KeyC" }))?.id).toBe(
      "tool.blade",
    );
  });

  it("matches Space and focus digit", () => {
    expect(matchKeymapCommand(keyEvent({ key: " ", code: "Space" }))?.id).toBe(
      "transport.togglePlay",
    );
    expect(matchKeymapCommand(keyEvent({ key: "1", code: "Digit1" }))?.id).toBe(
      "focus.default",
    );
  });

  it("matches Mod+A / Mod+Shift+A for track targeting", () => {
    expect(
      matchKeymapCommand(keyEvent({ key: "a", code: "KeyA", metaKey: true }))
        ?.id,
    ).toBe("track.selectAll");
    expect(
      matchKeymapCommand(
        keyEvent({
          key: "a",
          code: "KeyA",
          metaKey: true,
          shiftKey: true,
        }),
      )?.id,
    ).toBe("track.deselectAll");
  });

  it("matches Mod chords for edit clipboard, not bare tool keys", () => {
    expect(
      matchKeymapCommand(keyEvent({ key: "v", code: "KeyV", ctrlKey: true }))
        ?.id,
    ).toBe("edit.paste");
    expect(
      matchKeymapCommand(keyEvent({ key: "c", code: "KeyC", metaKey: true }))
        ?.id,
    ).toBe("edit.copy");
    expect(
      matchKeymapCommand(keyEvent({ key: "x", code: "KeyX", metaKey: true }))
        ?.id,
    ).toBe("edit.cut");
  });

  it("matches phase-2 P0 chords", () => {
    expect(matchKeymapCommand(keyEvent({ key: "k", code: "KeyK" }))?.id).toBe(
      "transport.stop",
    );
    expect(
      matchKeymapCommand(keyEvent({ key: "k", code: "KeyK", metaKey: true }))
        ?.id,
    ).toBe("edit.bladeCut");
    expect(
      matchKeymapCommand(keyEvent({ key: "Backspace", code: "Backspace" }))?.id,
    ).toBe("tighten.skipHit");
    expect(
      matchKeymapCommands(
        keyEvent({ key: "Backspace", code: "Backspace" }),
      ).map((c) => c.id),
    ).toEqual(["tighten.skipHit", "track.remove", "edit.delete"]);
    expect(
      matchKeymapCommand(keyEvent({ key: "Delete", code: "Delete" }))?.id,
    ).toBe("track.remove");
    expect(
      matchKeymapCommands(keyEvent({ key: "Delete", code: "Delete" })).map(
        (c) => c.id,
      ),
    ).toEqual(["track.remove", "edit.delete"]);
    expect(
      matchKeymapCommand(
        keyEvent({ key: "Backspace", code: "Backspace", metaKey: true }),
      )?.id,
    ).toBe("edit.rippleDelete");
    expect(
      matchKeymapCommand(keyEvent({ key: "Home", code: "Home" }))?.id,
    ).toBe("navigation.goToStart");
    expect(matchKeymapCommand(keyEvent({ key: "End", code: "End" }))?.id).toBe(
      "navigation.goToEnd",
    );
    expect(
      matchKeymapCommand(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }),
      )?.id,
    ).toBe("navigation.goToStart");
    expect(
      matchKeymapCommand(
        keyEvent({ key: "ArrowRight", code: "ArrowRight", metaKey: true }),
      )?.id,
    ).toBe("navigation.goToEnd");
    expect(
      matchKeymapCommands(keyEvent({ key: "Escape", code: "Escape" })).map(
        (c) => c.id,
      ),
    ).toEqual([
      "presence.unfollow",
      "review.exitCommentMode",
      "edit.clearSelection",
    ]);
    expect(matchKeymapCommand(keyEvent({ key: "m", code: "KeyM" }))?.id).toBe(
      "track.muteToggle",
    );
    expect(
      matchKeymapCommands(keyEvent({ key: "m", code: "KeyM" })).map(
        (c) => c.id,
      ),
    ).toEqual(["track.muteToggle", "record.marker"]);
    expect(matchKeymapCommand(keyEvent({ key: "s", code: "KeyS" }))?.id).toBe(
      "track.soloToggle",
    );
    expect(matchKeymapCommand(keyEvent({ key: "=", code: "Equal" }))?.id).toBe(
      "view.zoomIn",
    );
    expect(
      matchKeymapCommand(keyEvent({ key: "+", code: "NumpadAdd" }))?.id,
    ).toBe("view.zoomIn");
    expect(matchKeymapCommand(keyEvent({ key: "-", code: "Minus" }))?.id).toBe(
      "view.zoomOut",
    );
    expect(
      matchKeymapCommand(keyEvent({ key: "\\", code: "Backslash" }))?.id,
    ).toBe("view.fit");
    expect(
      matchKeymapCommand(
        keyEvent({
          key: "c",
          code: "KeyC",
          metaKey: true,
          shiftKey: true,
        }),
      )?.id,
    ).toBe("review.toggleCommentMode");
  });

  it("ignores bare letter tool shortcuts when Alt is held", () => {
    expect(
      matchKeymapCommand(keyEvent({ key: "v", code: "KeyV", altKey: true })),
    ).toBeNull();
  });

  it("matches Mod+Z undo and Mod+Shift+Z redo", () => {
    expect(
      matchKeymapCommand(keyEvent({ key: "z", code: "KeyZ", metaKey: true }))
        ?.id,
    ).toBe("history.undo");
    expect(
      matchKeymapCommand(
        keyEvent({
          key: "z",
          code: "KeyZ",
          metaKey: true,
          shiftKey: true,
        }),
      )?.id,
    ).toBe("history.redo");
  });

  it("still matches arrows with Shift for nudge notes", () => {
    expect(
      matchKeymapCommand(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }),
      )?.id,
    ).toBe("navigation.nudgePlayheadBack");
  });

  it("honors remap overrides", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("tool.select", ["B"]);
    expect(matchKeymapCommand(keyEvent({ key: "b", code: "KeyB" }))?.id).toBe(
      "tool.select",
    );
    _resetKeymapOverridesForTests();
  });
});
