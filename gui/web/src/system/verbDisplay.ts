import { isApplePlatform } from "../utils/platform";
import type { SystemIconName } from "./icons";
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

/**
 * Key caps for one chord, one string per cap: `Mod+Shift+Z` is `⌘ ⇧ Z` on
 * Apple platforms and `Ctrl ⇧ Z` elsewhere.
 */
export function capsOf(
  spec: KeySpec,
  apple: boolean = isApplePlatform(),
): string[] {
  return [
    spec.mod ? (apple ? "⌘" : "Ctrl") : "",
    spec.alt ? (apple ? "⌥" : "Alt") : "",
    spec.shift ? "⇧" : "",
    CAP_NAMES[spec.key] ?? spec.key,
  ].filter(Boolean);
}

/** The first chord of a verb as a tooltip suffix: ` (⌘ Z)`, or empty. */
export function hintOf(verb: VerbDef): string {
  const first = verb.keys[0];
  return first ? ` (${capsOf(first).join(" ")})` : "";
}

export function iconOf(id: VerbId): SystemIconName {
  const icon = verbOf(id).icon;
  if (!icon) throw new Error(`Verb ${id} has no icon`);
  return icon;
}

/** The first chord as `aria-keyshortcuts` names it: `Control+Shift+Z`, `Shift+Space`, or undefined. */
export function ariaShortcutOf(
  verb: VerbDef,
  apple: boolean = isApplePlatform(),
): string | undefined {
  const spec = verb.keys[0];
  if (!spec || spec.hold) return undefined;
  const key = spec.key.length === 1 ? spec.key.toUpperCase() : spec.key;
  return [
    spec.mod ? (apple ? "Meta" : "Control") : "",
    spec.alt ? "Alt" : "",
    spec.shift ? "Shift" : "",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
