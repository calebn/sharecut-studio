import { type KeySpec, VERBS, type VerbDef, type VerbId } from "./verbs";

export function verbOf(id: VerbId): VerbDef {
  const verb = VERBS.find((entry) => entry.id === id);
  if (!verb) throw new Error(`Unknown verb ${id}`);
  return verb;
}

const CAP_NAMES: Record<string, string> = {
  Backspace: "⌫",
  Delete: "Del",
  Enter: "↵",
  ArrowDown: "↓",
  ArrowUp: "↑",
  Space: "Space",
};

/** Key caps for one chord, one string per cap: `Mod+Shift+Z` is `⌘ ⇧ Z`. */
export function capsOf(spec: KeySpec): string[] {
  return [
    spec.mod ? "⌘" : "",
    spec.alt ? "⌥" : "",
    spec.shift ? "⇧" : "",
    CAP_NAMES[spec.key] ?? spec.key,
  ].filter(Boolean);
}

/** The first chord of a verb as a tooltip suffix: ` (⌘ Z)`, or empty. */
export function hintOf(verb: VerbDef): string {
  const first = verb.keys[0];
  return first ? ` (${capsOf(first).join(" ")})` : "";
}
