import { COMMANDS } from "./catalog";

/**
 * The visible name of a catalog command: `label`, or its declared `shortLabel`
 * for a narrow control. Chrome that is not a `CommandButton` or
 * `CommandMenuItem` (an icon-only toggle's accessible name, a menu row built
 * from a descriptor) reads the name here instead of typing its own.
 */
export function commandLabel(
  commandId: string,
  form: "full" | "short" = "full",
): string {
  const def = COMMANDS[commandId];
  if (!def) {
    throw new Error(`Unknown command id: ${commandId}`);
  }
  return form === "short" ? (def.shortLabel ?? def.label) : def.label;
}
