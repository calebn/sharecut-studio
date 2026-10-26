import { describe, expect, it } from "vitest";
import { COMMANDS } from "../commands/catalog";
import { matchKeymapCommands, SHARED_KEY_ORDER } from "../keymap/registry";
import { SYSTEM_ICON_NAMES } from "./icons";
import {
  BROWSER_RESERVED_KEYS,
  CHORD_ALLOW_GROUPS,
  chordOf,
  GESTURE_GRAMMAR,
  ICON_TIES,
  STAGES,
  STATUS_GLYPHS,
  type TouchGesture,
  VERBS,
  type VerbDef,
} from "./verbs";

const rows: readonly VerbDef[] = VERBS;

const TOUCH: readonly TouchGesture[] = [
  "tap",
  "double-tap",
  "long-press",
  "press-and-hold",
  "swipe-right",
  "swipe-left",
  "swipe-up",
  "swipe-down",
  "swipe-timeline",
  "swipe-dock-up",
  "pinch",
  "two-finger-tap",
  "three-finger-swipe",
];

function verbsByChord() {
  const byChord = new Map<string, string[]>();
  for (const verb of rows) {
    for (const chord of new Set(verb.keys.map(chordOf))) {
      byChord.set(chord, [...(byChord.get(chord) ?? []), verb.id]);
    }
  }
  return byChord;
}

describe("verb table", () => {
  it("has unique ids and labels", () => {
    expect(new Set(rows.map((v) => v.id)).size).toBe(rows.length);
    expect(new Set(rows.map((v) => v.label)).size).toBe(rows.length);
  });

  it("does not repeat a chord inside one verb", () => {
    for (const verb of rows) {
      const chords = verb.keys.map(chordOf);
      expect(new Set(chords).size, verb.id).toBe(chords.length);
    }
  });

  it("shares a chord only inside a declared allow-group", () => {
    const stray: string[] = [];
    for (const [chord, ids] of verbsByChord()) {
      if (ids.length < 2) continue;
      const group = CHORD_ALLOW_GROUPS.find((g) =>
        (g.chords as readonly string[]).includes(chord),
      );
      const allowed = new Set<string>(group?.verbs ?? []);
      if (!group || ids.some((id) => !allowed.has(id))) {
        stray.push(`${chord}: ${ids.join(", ")}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("only declares groups that really share the chord", () => {
    const byChord = verbsByChord();
    for (const group of CHORD_ALLOW_GROUPS) {
      expect(group.reason).not.toBe("");
      for (const chord of group.chords) {
        const ids = byChord.get(chord) ?? [];
        expect(new Set(ids), chord).toEqual(new Set(group.verbs));
      }
    }
  });

  it("uses no browser-reserved chord", () => {
    const reserved = rows.flatMap((verb) =>
      verb.keys
        .filter(
          (spec) =>
            spec.mod &&
            (BROWSER_RESERVED_KEYS as readonly string[]).includes(spec.key),
        )
        .map((spec) => `${verb.id}: ${chordOf(spec)}`),
    );
    expect(reserved).toEqual([]);
  });

  it("shares an icon only where the design system ties it", () => {
    const owners = new Map<string, Set<string>>();
    const add = (icon: string | null | undefined, owner: string) => {
      if (icon) owners.set(icon, (owners.get(icon) ?? new Set()).add(owner));
    };
    for (const verb of rows) {
      add(verb.icon, verb.id);
      add(verb.iconAlt, verb.id);
    }
    for (const stage of STAGES) add(stage.icon, `stage:${stage.id}`);
    for (const glyph of STATUS_GLYPHS)
      add(glyph.glyph, `status:${glyph.state}`);
    for (const tie of ICON_TIES) {
      for (const owner of tie.owners) {
        if (owner.startsWith("role:")) add(tie.icon, owner);
      }
    }
    const tied = new Map<string, Set<string>>(
      ICON_TIES.map((tie) => [tie.icon, new Set<string>(tie.owners)]),
    );
    const stray = [...owners]
      .filter(([, set]) => set.size > 1)
      .filter(([icon, set]) => {
        const allowed = tied.get(icon);
        return (
          !allowed ||
          allowed.size !== set.size ||
          [...set].some((o) => !allowed.has(o))
        );
      })
      .map(([icon, set]) => `${icon}: ${[...set].join(", ")}`);
    expect(stray).toEqual([]);
    for (const tie of ICON_TIES) {
      expect(owners.get(tie.icon), tie.icon).toEqual(new Set(tie.owners));
    }
  });

  it("resolves every icon, stage and status glyph", () => {
    const names = new Set<string>(SYSTEM_ICON_NAMES);
    const used = [
      ...rows.flatMap((v) => [v.icon, v.iconAlt]),
      ...STAGES.map((s) => s.icon),
      ...STATUS_GLYPHS.map((s) => s.glyph),
    ].filter((name): name is NonNullable<typeof name> => name != null);
    expect(used.filter((name) => !names.has(name))).toEqual([]);
  });

  it("gives each stage its own icon", () => {
    const icons = STAGES.map((s) => s.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("orders stages Record, Prepare, Edit, Review, Deliver on Mod+1 to Mod+5", () => {
    expect(STAGES.map((s) => s.id)).toEqual([
      "record",
      "prepare",
      "edit",
      "review",
      "deliver",
    ]);
    expect(STAGES.map((s) => chordOf(s.key))).toEqual([
      "Mod+1",
      "Mod+2",
      "Mod+3",
      "Mod+4",
      "Mod+5",
    ]);
    const goTo = rows.find((v) => v.id === "goToStage");
    for (const stage of STAGES) {
      expect(goTo?.keys.map(chordOf)).toContain(chordOf(stage.key));
    }
  });

  it("has distinct status states", () => {
    const states = STATUS_GLYPHS.map((s) => s.state);
    expect(new Set(states).size).toBe(states.length);
  });

  it("uses only known touch gestures", () => {
    for (const verb of rows) {
      if (verb.touch) expect(TOUCH, verb.id).toContain(verb.touch);
    }
    for (const entry of GESTURE_GRAMMAR) expect(TOUCH).toContain(entry.gesture);
  });

  it("keeps swipes to the grammar: right is the primary, left is no", () => {
    const ids = (gesture: TouchGesture) =>
      rows.filter((v) => v.touch === gesture).map((v) => v.id);
    expect(ids("swipe-left").sort()).toEqual(["keep", "remove"]);
    expect(ids("swipe-right").sort()).toEqual(
      [
        "approve",
        "cut",
        "insert",
        "lower",
        "replace",
        "resolve",
        "shorten",
      ].sort(),
    );
  });

  it("points commandId and replaces at real catalog commands", () => {
    const missing = rows.flatMap((v) =>
      [v.commandId, ...(v.replaces ?? [])]
        .filter((id): id is string => id != null && !(id in COMMANDS))
        .map((id) => `${v.id}: ${id}`),
    );
    expect(missing).toEqual([]);
  });

  it("records the status honestly", () => {
    for (const verb of rows) {
      const replaces = verb.replaces ?? [];
      if (verb.status === "conflict") {
        expect(replaces.length, verb.id).toBeGreaterThan(0);
      } else {
        expect(replaces, verb.id).toEqual([]);
      }
      if (verb.status === "bound") {
        expect(verb.commandId, verb.id).toBeDefined();
      }
    }
  });

  it("keeps bare single-letter keys to one verb each", () => {
    const bare = rows.flatMap((v) =>
      v.keys
        .filter(
          (s) =>
            /^[A-Z]$/.test(s.key) && !s.mod && !s.shift && !s.alt && !s.hold,
        )
        .map((s) => s.key),
    );
    expect(new Set(bare).size).toBe(bare.length);
  });
});

/** The keys of a verb as the keymap sees them: ids of every live command. */
function liveOwners(verb: VerbDef): string[] {
  const ids = new Set<string>();
  for (const spec of verb.keys) {
    const matched = matchKeymapCommands(
      {
        key: spec.key === "Space" ? " " : spec.key,
        code: "",
        metaKey: spec.mod === true,
        ctrlKey: false,
        altKey: spec.alt === true,
        shiftKey: spec.shift === true,
      },
      false,
    );
    for (const command of matched) ids.add(command.id);
  }
  return [...ids];
}

/** Commands the registry itself orders on one shared key (Escape, Backspace, M). */
function sharedMates(commandId: string | undefined): string[] {
  if (!commandId) return [];
  return SHARED_KEY_ORDER.filter((entry) =>
    entry.order.includes(commandId),
  ).flatMap((entry) => [...entry.order]);
}

describe("verb table against the live keymap", () => {
  it("explains every live owner of a verb's keys", () => {
    const unexplained = rows.flatMap((verb) => {
      const known = new Set<string>([
        ...(verb.commandId ? [verb.commandId] : []),
        ...(verb.replaces ?? []),
        ...(verb.alsoBound ?? []),
        ...sharedMates(verb.commandId),
      ]);
      return liveOwners(verb)
        .filter((id) => !known.has(id))
        .map((id) => `${verb.id}: ${id}`);
    });
    expect(unexplained).toEqual([]);
  });

  it("lists in replaces only commands that really own a key of the verb", () => {
    const stale = rows.flatMap((verb) => {
      const owners = new Set(liveOwners(verb));
      return (verb.replaces ?? [])
        .filter((id) => !owners.has(id))
        .map((id) => `${verb.id}: ${id}`);
    });
    expect(stale).toEqual([]);
  });

  it("marks bound only when a key drives the command, new only when none does", () => {
    const wrong = rows.flatMap((verb) => {
      if (!verb.commandId) return [];
      const driven = liveOwners(verb).includes(verb.commandId);
      if (verb.status === "bound" && !driven) return [`${verb.id}: not bound`];
      if (verb.status === "new" && driven) return [`${verb.id}: already bound`];
      return [];
    });
    expect(wrong).toEqual([]);
  });

  it("never gives a bare key to a verb marked new if a command owns it", () => {
    const wrong = rows
      .filter((verb) => verb.status === "new")
      .filter((verb) => liveOwners(verb).length > 0)
      .map((verb) => verb.id);
    expect(wrong).toEqual([]);
  });

  it("does not hand Mod+X to Cut", () => {
    const cut = rows.find((verb) => verb.id === "cut");
    expect(cut?.keys.map(chordOf)).toEqual(["Backspace", "Delete"]);
  });
});
