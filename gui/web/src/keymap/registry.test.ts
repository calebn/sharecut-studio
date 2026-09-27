import { describe, expect, it } from "vitest";
import {
  ariaKeyShortcutsFor,
  displayShortcutFor,
  displayShortcutKeys,
  formatShortcutKeys,
  ignoresKeyRepeat,
  KEYMAP_COMMANDS,
  keymapByCategory,
  keymapCommandById,
  matchKeymapCommand,
  matchKeymapCommands,
  titleWithShortcut,
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
    expect(ids).toContain("layout.timeline");
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
    expect(by.layout).toHaveLength(4);
  });

  it("matches V and C case-insensitively", () => {
    expect(matchKeymapCommand(keyEvent({ key: "v", code: "KeyV" }))?.id).toBe(
      "tool.select",
    );
    expect(matchKeymapCommand(keyEvent({ key: "C", code: "KeyC" }))?.id).toBe(
      "tool.blade",
    );
  });

  it("matches Space and Mod+digit layouts", () => {
    expect(matchKeymapCommand(keyEvent({ key: " ", code: "Space" }))?.id).toBe(
      "transport.togglePlay",
    );
    expect(
      matchKeymapCommand(keyEvent({ key: "1", code: "Digit1" })),
    ).toBeNull();
    expect(
      matchKeymapCommand(keyEvent({ key: "1", code: "Digit1", metaKey: true }))
        ?.id,
    ).toBe("layout.default");
    expect(
      matchKeymapCommand(keyEvent({ key: "2", code: "Digit2", ctrlKey: true }))
        ?.id,
    ).toBe("layout.timeline");
    expect(formatShortcutKeys(keymapCommandById("layout.text")!)).toBe("Mod+3");
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

describe("Alt chords", () => {
  it("matches Alt+= (key or macOS ≠) and Alt+NumpadAdd to track height increase", () => {
    expect(
      matchKeymapCommand(keyEvent({ key: "=", code: "Equal", altKey: true }))
        ?.id,
    ).toBe("view.trackHeightIncrease");
    expect(
      matchKeymapCommand(keyEvent({ key: "≠", code: "Equal", altKey: true }))
        ?.id,
    ).toBe("view.trackHeightIncrease");
    expect(
      matchKeymapCommand(
        keyEvent({ key: "+", code: "NumpadAdd", altKey: true }),
      )?.id,
    ).toBe("view.trackHeightIncrease");
  });

  it("matches Alt+- (key or macOS –) to track height decrease", () => {
    expect(
      matchKeymapCommand(keyEvent({ key: "-", code: "Minus", altKey: true }))
        ?.id,
    ).toBe("view.trackHeightDecrease");
    expect(
      matchKeymapCommand(keyEvent({ key: "–", code: "Minus", altKey: true }))
        ?.id,
    ).toBe("view.trackHeightDecrease");
  });

  it("leaves plain = as zoom, never track height", () => {
    expect(matchKeymapCommand(keyEvent({ key: "=", code: "Equal" }))?.id).toBe(
      "view.zoomIn",
    );
    expect(
      matchKeymapCommands(keyEvent({ key: "=", code: "Equal" })).map(
        (c) => c.id,
      ),
    ).not.toContain("view.trackHeightIncrease");
  });

  it("does not match Mod+Alt+=", () => {
    expect(
      matchKeymapCommand(
        keyEvent({
          key: "=",
          code: "Equal",
          altKey: true,
          metaKey: true,
        }),
      ),
    ).toBeNull();
  });

  it("displays and formats Alt+= / Alt+-", () => {
    const increase = keymapCommandById("view.trackHeightIncrease")!;
    expect(formatShortcutKeys(increase)).toBe("Alt+=");
    expect(displayShortcutKeys(increase, true)).toBe("⌥=");
    expect(displayShortcutKeys(increase, false)).toBe("Alt+=");
    expect(ariaKeyShortcutsFor("view.trackHeightDecrease")).toContain("Alt");
  });

  it("matches a remapped Alt row by physical code on macOS", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("view.trackHeightIncrease", ["]"]);
    expect(
      matchKeymapCommand(
        keyEvent({ key: "’", code: "BracketRight", altKey: true }),
      )?.id,
    ).toBe("view.trackHeightIncrease");
    expect(
      matchKeymapCommand(
        keyEvent({ key: "]", code: "BracketRight", altKey: true }),
      )?.id,
    ).toBe("view.trackHeightIncrease");
    setKeymapOverride("view.trackHeightIncrease", ["K"]);
    expect(
      matchKeymapCommand(keyEvent({ key: "˚", code: "KeyK", altKey: true }))
        ?.id,
    ).toBe("view.trackHeightIncrease");
    setKeymapOverride("view.trackHeightIncrease", ["7"]);
    expect(
      matchKeymapCommand(keyEvent({ key: "¶", code: "Digit7", altKey: true }))
        ?.id,
    ).toBe("view.trackHeightIncrease");
    _resetKeymapOverridesForTests();
  });

  it("does not add code-derived keys without Alt", () => {
    expect(
      matchKeymapCommands(keyEvent({ key: "≠", code: "Equal" })).map(
        (c) => c.id,
      ),
    ).not.toContain("view.zoomIn");
  });

  it("ignores the physical code when Alt types a printable ASCII key", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("view.trackHeightIncrease", ["A"]);
    // AZERTY: the physical KeyA key types "q".
    expect(
      matchKeymapCommands(
        keyEvent({ key: "q", code: "KeyA", altKey: true }),
      ).map((c) => c.id),
    ).not.toContain("view.trackHeightIncrease");
    _resetKeymapOverridesForTests();
    // Windows Dvorak: the physical Equal key types "]".
    expect(
      matchKeymapCommands(
        keyEvent({ key: "]", code: "Equal", altKey: true }),
      ).map((c) => c.id),
    ).not.toContain("view.trackHeightIncrease");
  });

  it("matches a macOS dead-key Alt chord by physical code", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("view.trackHeightIncrease", ["E"]);
    expect(
      matchKeymapCommand(keyEvent({ key: "Dead", code: "KeyE", altKey: true }))
        ?.id,
    ).toBe("view.trackHeightIncrease");
    _resetKeymapOverridesForTests();
  });
});

describe("displayShortcutKeys", () => {
  it("uses platform modifiers instead of Mod", () => {
    const bounce = keymapCommandById("export.bounce")!;
    expect(displayShortcutKeys(bounce, true)).toBe("⌘⇧B");
    expect(displayShortcutKeys(bounce, false)).toBe("Ctrl+Shift+B");
  });

  it("keeps bare keys and names Space", () => {
    expect(displayShortcutKeys(keymapCommandById("tool.select")!, true)).toBe(
      "V",
    );
    expect(
      displayShortcutKeys(keymapCommandById("transport.togglePlay")!, false),
    ).toBe("Space");
  });
});

describe("remapped shortcuts", () => {
  it("replace the key only, so display and matching agree", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("export.bounce", ["X"]);
    const bounce = keymapCommandById("export.bounce")!;
    expect(formatShortcutKeys(bounce)).toBe("Mod+Shift+X");
    expect(displayShortcutKeys(bounce, true)).toBe("⌘⇧X");
    expect(
      matchKeymapCommand(
        keyEvent({ key: "X", code: "KeyX", metaKey: true, shiftKey: true }),
      )?.id,
    ).toBe("export.bounce");
    // Bare X alone must not look bound in menus nor fire Bounce.
    expect(
      matchKeymapCommand(keyEvent({ key: "x", code: "KeyX" }))?.id,
    ).not.toBe("export.bounce");
    _resetKeymapOverridesForTests();
  });

  it("normalize a typed combo to its key", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("export.bounce", ["Mod+Shift+Y"]);
    expect(displayShortcutFor("export.bounce", false)).toBe("Ctrl+Shift+Y");
    expect(
      matchKeymapCommand(
        keyEvent({ key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true }),
      )?.id,
    ).toBe("export.bounce");
    _resetKeymapOverridesForTests();
  });
});

describe("shortcut helpers by command id", () => {
  it("titleWithShortcut omits empty parentheses", () => {
    expect(titleWithShortcut("Restore layout", "layout.default", true)).toBe(
      "Restore layout (⌘1)",
    );
    expect(titleWithShortcut("Anything", "not.a.command")).toBe("Anything");
  });

  it("format menu labels and aria-keyshortcuts per platform", () => {
    expect(displayShortcutFor("export.bounce", true)).toBe("⌘⇧B");
    expect(displayShortcutFor("not.a.command")).toBeUndefined();
    expect(ariaKeyShortcutsFor("export.bounce", true)).toBe("Meta+Shift+B");
    expect(ariaKeyShortcutsFor("export.bounce", false)).toBe("Control+Shift+B");
    expect(ariaKeyShortcutsFor("transport.togglePlay", true)).toBe("Space");
  });
});

describe("held keys", () => {
  it("don't auto-repeat the M and S toggles", () => {
    const row = (id: string) => {
      const cmd = keymapCommandById(id);
      if (!cmd) {
        throw new Error(id);
      }
      return cmd;
    };
    expect(ignoresKeyRepeat({ repeat: true }, row("track.muteToggle"))).toBe(
      true,
    );
    expect(ignoresKeyRepeat({ repeat: true }, row("track.soloToggle"))).toBe(
      true,
    );
    expect(ignoresKeyRepeat({ repeat: false }, row("track.muteToggle"))).toBe(
      false,
    );
    expect(
      ignoresKeyRepeat(
        { repeat: true },
        row("navigation.nudgePlayheadForward"),
      ),
    ).toBe(false);
  });
});
