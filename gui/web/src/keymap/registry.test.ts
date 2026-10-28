import { describe, expect, it } from "vitest";
import {
  ariaKeyShortcutsFor,
  displayShortcutFor,
  displayShortcutKeys,
  formatShortcutKeys,
  ignoresKeyRepeat,
  KEYMAP_CATEGORY_ORDER,
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
  it("F2 edits a focused word while Enter has no global transcript binding", () => {
    expect(matchKeymapCommand(keyEvent({ key: "F2" }))?.id).toBe(
      "transcript.editWordInline",
    );
    expect(
      matchKeymapCommands(keyEvent({ key: "Enter" })).some((cmd) =>
        cmd.id.startsWith("transcript."),
      ),
    ).toBe(false);
  });
  it("includes stable command ids for transport and stages", () => {
    const ids = KEYMAP_COMMANDS.map((c) => c.id);
    expect(ids).toContain("transport.togglePlay");
    expect(ids).toContain("stage.review");
    expect(ids).toContain("history.undo");
  });

  it("KEYMAP_CATEGORY_ORDER lists each category once, covers every command, and has no empty category", () => {
    expect(new Set(KEYMAP_CATEGORY_ORDER).size).toBe(
      KEYMAP_CATEGORY_ORDER.length,
    );
    const known = new Set<string>(KEYMAP_CATEGORY_ORDER);
    for (const cmd of KEYMAP_COMMANDS) {
      expect(known.has(cmd.category), cmd.id).toBe(true);
    }
    const byCategory = keymapByCategory();
    for (const category of KEYMAP_CATEGORY_ORDER) {
      expect(byCategory[category].length, category).toBeGreaterThan(0);
    }
  });

  it("formats display keys", () => {
    expect(formatShortcutKeys(keymapCommandById("edit.bladeCut")!)).toBe(
      "Mod+K",
    );
    expect(formatShortcutKeys(keymapCommandById("transport.togglePlay")!)).toBe(
      "Space",
    );
    expect(formatShortcutKeys(keymapCommandById("history.undo")!)).toBe(
      "Mod+Z",
    );
  });

  it("groups by category for cheatsheet consumers", () => {
    const by = keymapByCategory();
    expect(
      by.navigation.filter((c) => c.id.startsWith("stage.")).map((c) => c.id),
    ).toEqual([
      "stage.record",
      "stage.prepare",
      "stage.edit",
      "stage.review",
      "stage.deliver",
    ]);
  });

  it("binds nothing to V or Mod+Shift+C, and C is Comment now that the tools are gone", () => {
    for (const event of [
      keyEvent({ key: "v", code: "KeyV" }),
      keyEvent({ key: "c", code: "KeyC", metaKey: true, shiftKey: true }),
    ])
      expect(matchKeymapCommands(event)).toEqual([]);
    for (const id of [
      "tool.select",
      "tool.blade",
      "review.toggleCommentMode",
      "review.exitCommentMode",
    ])
      expect(keymapCommandById(id)).toBeUndefined();
  });

  it("binds the Action bar's keys: C, Shift+C, X, I, ., A, B, S, Shift+S, Shift+Space and M", () => {
    const first = (event: Parameters<typeof keyEvent>[0]) =>
      matchKeymapCommands(keyEvent(event)).map((c) => c.id);
    expect(first({ key: "c", code: "KeyC" })).toEqual(["comment.draftAt"]);
    expect(first({ key: "C", code: "KeyC", shiftKey: true })).toEqual([
      "edit.addChapter",
    ]);
    expect(first({ key: "x", code: "KeyX" })).toEqual(["edit.keep"]);
    expect(first({ key: "i", code: "KeyI" })).toEqual(["edit.inspect"]);
    expect(first({ key: ".", code: "Period" })).toEqual(["edit.more"]);
    expect(first({ key: "a", code: "KeyA" })).toEqual(["edit.hearBefore"]);
    expect(first({ key: "b", code: "KeyB" })).toEqual(["edit.hearAfter"]);
    expect(first({ key: "s", code: "KeyS" })).toEqual(["edit.split"]);
    expect(first({ key: "S", code: "KeyS", shiftKey: true })).toEqual([
      "track.soloToggle",
    ]);
    expect(first({ key: " ", code: "Space", shiftKey: true })).toEqual([
      "edit.hear",
    ]);
    expect(first({ key: " ", code: "Space" })).toEqual([
      "transport.togglePlay",
    ]);
    expect(first({ key: "m", code: "KeyM" })).toContain("edit.mute");
    expect(first({ key: "x", code: "KeyX", metaKey: true })).toEqual([
      "edit.cut",
    ]);
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
    ).toBe("stage.record");
    expect(
      matchKeymapCommand(keyEvent({ key: "2", code: "Digit2", ctrlKey: true }))
        ?.id,
    ).toBe("stage.prepare");
    expect(formatShortcutKeys(keymapCommandById("stage.edit")!)).toBe("Mod+3");
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
    ).toEqual(["edit.clearSelection", "presence.unfollow"]);
    expect(matchKeymapCommand(keyEvent({ key: "m", code: "KeyM" }))?.id).toBe(
      "record.marker",
    );
    expect(
      matchKeymapCommands(keyEvent({ key: "m", code: "KeyM" })).map(
        (c) => c.id,
      ),
    ).toEqual(["record.marker", "edit.mute"]);
    expect(matchKeymapCommand(keyEvent({ key: "s", code: "KeyS" }))?.id).toBe(
      "edit.split",
    );
    expect(
      matchKeymapCommand(keyEvent({ key: "S", code: "KeyS", shiftKey: true }))
        ?.id,
    ).toBe("track.soloToggle");
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
  });

  it("ignores bare letter shortcuts when Alt is held", () => {
    expect(
      matchKeymapCommand(keyEvent({ key: "s", code: "KeyS", altKey: true })),
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

  it("matches focused clip arrows before Shift playhead nudges", () => {
    expect(
      matchKeymapCommands(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }),
      )
        .map((command) => command.id)
        .slice(0, 2),
    ).toEqual(["edit.setClipFade", "edit.trimClipEdge"]);
    expect(
      matchKeymapCommands(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }),
      ).map((command) => command.id),
    ).toContain("navigation.nudgePlayheadBack");
  });

  it("honors remap overrides", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("track.soloToggle", ["Q"]);
    expect(
      matchKeymapCommand(keyEvent({ key: "Q", code: "KeyQ", shiftKey: true }))
        ?.id,
    ).toBe("track.soloToggle");
    _resetKeymapOverridesForTests();
  });

  it("keeps a remapped Solo key working without Shift", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("track.soloToggle", ["L"]);
    expect(matchKeymapCommand(keyEvent({ key: "l", code: "KeyL" }))?.id).toBe(
      "track.soloToggle",
    );
    expect(formatShortcutKeys(keymapCommandById("track.soloToggle")!)).toBe(
      "L",
    );
    _resetKeymapOverridesForTests();
    expect(
      matchKeymapCommand(keyEvent({ key: "s", code: "KeyS" }))?.id,
    ).not.toBe("track.soloToggle");
  });
});

describe("Alt chords", () => {
  it("matches Alt+= (key or macOS ≠) and Alt+NumpadAdd to track height increase", () => {
    expect(
      matchKeymapCommand(keyEvent({ key: "=", code: "Equal", altKey: true }))
        ?.id,
    ).toBe("view.trackHeightIncrease");
    expect(
      matchKeymapCommand(
        keyEvent({ key: "≠", code: "Equal", altKey: true }),
        true,
      )?.id,
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
      matchKeymapCommand(
        keyEvent({ key: "–", code: "Minus", altKey: true }),
        true,
      )?.id,
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
        true,
      )?.id,
    ).toBe("view.trackHeightIncrease");
    expect(
      matchKeymapCommand(
        keyEvent({ key: "]", code: "BracketRight", altKey: true }),
        true,
      )?.id,
    ).toBe("view.trackHeightIncrease");
    setKeymapOverride("view.trackHeightIncrease", ["K"]);
    expect(
      matchKeymapCommand(
        keyEvent({ key: "˚", code: "KeyK", altKey: true }),
        true,
      )?.id,
    ).toBe("view.trackHeightIncrease");
    setKeymapOverride("view.trackHeightIncrease", ["7"]);
    expect(
      matchKeymapCommand(
        keyEvent({ key: "¶", code: "Digit7", altKey: true }),
        true,
      )?.id,
    ).toBe("view.trackHeightIncrease");
    _resetKeymapOverridesForTests();
  });

  it("does not add code-derived keys without Alt", () => {
    expect(
      matchKeymapCommands(keyEvent({ key: "≠", code: "Equal" }), true).map(
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
        true,
      ).map((c) => c.id),
    ).not.toContain("view.trackHeightIncrease");
    _resetKeymapOverridesForTests();
    // Windows Dvorak: the physical Equal key types "]".
    expect(
      matchKeymapCommands(
        keyEvent({ key: "]", code: "Equal", altKey: true }),
        true,
      ).map((c) => c.id),
    ).not.toContain("view.trackHeightIncrease");
  });

  it("matches a macOS dead-key Alt chord by physical code", () => {
    _resetKeymapOverridesForTests();
    setKeymapOverride("view.trackHeightIncrease", ["E"]);
    expect(
      matchKeymapCommand(
        keyEvent({ key: "Dead", code: "KeyE", altKey: true }),
        true,
      )?.id,
    ).toBe("view.trackHeightIncrease");
    _resetKeymapOverridesForTests();
  });

  it("never matches Alt rows by physical code off Apple platforms", () => {
    _resetKeymapOverridesForTests();
    // German QWERTZ: the physical Minus key types "ß"; "-" is on Slash.
    expect(
      matchKeymapCommands(
        keyEvent({ key: "ß", code: "Minus", altKey: true }),
        false,
      ).map((c) => c.id),
    ).not.toContain("view.trackHeightDecrease");
    // German dead acute on the physical Equal key.
    expect(
      matchKeymapCommands(
        keyEvent({ key: "Dead", code: "Equal", altKey: true }),
        false,
      ).map((c) => c.id),
    ).not.toContain("view.trackHeightIncrease");
    // Cyrillic: the physical KeyA key types "ф".
    setKeymapOverride("view.trackHeightIncrease", ["A"]);
    expect(
      matchKeymapCommands(
        keyEvent({ key: "ф", code: "KeyA", altKey: true }),
        false,
      ).map((c) => c.id),
    ).not.toContain("view.trackHeightIncrease");
    _resetKeymapOverridesForTests();
    // The layout's own ASCII key still matches.
    expect(
      matchKeymapCommand(
        keyEvent({ key: "-", code: "Slash", altKey: true }),
        false,
      )?.id,
    ).toBe("view.trackHeightDecrease");
  });
});

describe("displayShortcutKeys", () => {
  it("uses platform modifiers instead of Mod", () => {
    const bounce = keymapCommandById("export.bounce")!;
    expect(displayShortcutKeys(bounce, true)).toBe("⌘⇧B");
    expect(displayShortcutKeys(bounce, false)).toBe("Ctrl+Shift+B");
  });

  it("keeps bare keys and names Space", () => {
    expect(displayShortcutKeys(keymapCommandById("edit.split")!, true)).toBe(
      "S",
    );
    expect(
      displayShortcutKeys(keymapCommandById("track.soloToggle")!, true),
    ).toBe("⇧S");
    expect(displayShortcutKeys(keymapCommandById("edit.hear")!, false)).toBe(
      "Shift+Space",
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
    expect(titleWithShortcut("Go to Record", "stage.record", true)).toBe(
      "Go to Record (⌘1)",
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
    expect(ignoresKeyRepeat({ repeat: true }, row("edit.mute"))).toBe(true);
    expect(ignoresKeyRepeat({ repeat: true }, row("track.soloToggle"))).toBe(
      true,
    );
    expect(ignoresKeyRepeat({ repeat: false }, row("edit.mute"))).toBe(false);
    expect(
      ignoresKeyRepeat(
        { repeat: true },
        row("navigation.nudgePlayheadForward"),
      ),
    ).toBe(false);
  });

  it("opens the create menu on Shift+F10 and the Menu key, not on a bare F10 (#1877)", () => {
    expect(
      matchKeymapCommands(keyEvent({ key: "F10", shiftKey: true })).map(
        (cmd) => cmd.id,
      ),
    ).toContain("create.menu");
    expect(
      matchKeymapCommands(keyEvent({ key: "ContextMenu" })).map(
        (cmd) => cmd.id,
      ),
    ).toContain("create.menu");
    expect(
      matchKeymapCommands(keyEvent({ key: "F10" })).map((cmd) => cmd.id),
    ).not.toContain("create.menu");
  });
});
