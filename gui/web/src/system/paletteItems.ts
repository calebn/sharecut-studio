import type { PaletteItem } from "./Palette";
import { STAGES, VERBS } from "./verbs";

/** `action-bar` is shown as "Action bar". */
function contextOf(surface: string | undefined): string | undefined {
  if (!surface) return undefined;
  const words = surface.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Command and stage rows straight from the verb table. */
export function verbPaletteItems(): PaletteItem[] {
  return [
    ...VERBS.filter(
      // Verbs with no key (Invite, Copy link, Propose) are palette-only, so
      // they belong here. Go to stage is listed once per stage below.
      (verb) => verb.icon !== null && verb.id !== "goToStage",
    ).map(
      (verb): PaletteItem => ({
        id: `verb:${verb.id}`,
        group: "Commands",
        label: verb.label,
        icon: verb.icon,
        context: contextOf(verb.surfaces[0]),
        keys: verb.keys,
      }),
    ),
    ...STAGES.map(
      (stage): PaletteItem => ({
        id: `stage:${stage.id}`,
        group: "Stages",
        label: `Go to ${stage.label}`,
        icon: stage.icon,
        keys: [stage.key],
      }),
    ),
  ];
}
