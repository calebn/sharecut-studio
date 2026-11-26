import type { KitListRow } from "../api";
import { isDamagedKit } from "../api";

/** The server's cap on a kit name (`MAX_NAME_CHARS`). */
export const KIT_NAME_MAX = 200;

export const KIT_NAME_REQUIRED = "Enter a name for the kit.";
export const KIT_NAME_TOO_LONG = `Use ${KIT_NAME_MAX} characters or fewer.`;
export const KIT_NAME_NO_LETTER =
  "Use at least one letter or digit from a to z.";

/**
 * Why the studio would refuse `name`, or null. Mirrors `kit_id_for`: the name is trimmed,
 * folded to ASCII (NFKD, then anything outside ASCII dropped) and needs one letter or
 * digit left. The studio stays the authority on exotic text; this only saves a round trip.
 */
export function kitNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return KIT_NAME_REQUIRED;
  if ([...trimmed].length > KIT_NAME_MAX) return KIT_NAME_TOO_LONG;
  const folded = trimmed.normalize("NFKD").replace(/\P{ASCII}/gu, "");
  return /[a-z0-9]/i.test(folded) ? null : KIT_NAME_NO_LETTER;
}

export type NameMatch =
  | { kind: "new" }
  | { kind: "version"; name: string }
  | { kind: "lookalike"; name: string };

/**
 * What saving under `name` does to the library: the same trimmed text is the next version
 * of that kit, unless nothing differs from its newest version (the studio says so); a name that differs only in case is a second kit, which is usually a slip.
 */
export function matchKitName(
  name: string,
  rows: readonly KitListRow[] | null,
): NameMatch {
  const trimmed = name.trim();
  let lookalike: string | null = null;
  for (const row of rows ?? []) {
    if (isDamagedKit(row)) continue;
    if (row.name === trimmed) {
      return { kind: "version", name: row.name };
    }
    if (row.name.toLowerCase() === trimmed.toLowerCase()) lookalike = row.name;
  }
  return lookalike === null
    ? { kind: "new" }
    : { kind: "lookalike", name: lookalike };
}

export function nameHint(match: NameMatch): string {
  if (match.kind === "version") {
    return `Saves to the existing kit ${match.name} if anything changed. The earlier version is kept.`;
  }
  if (match.kind === "lookalike") {
    return `A kit called ${match.name} exists. This saves a separate kit.`;
  }
  return "Saves a new kit.";
}
