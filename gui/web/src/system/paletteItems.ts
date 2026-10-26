import type { PaletteItem } from "./Palette";
import { STAGES, VERBS } from "./verbs";

/** Command and stage rows straight from the verb table. */
export function verbPaletteItems(): PaletteItem[] {
  return [
    ...VERBS.filter((verb) => verb.icon !== null && verb.keys.length > 0).map(
      (verb): PaletteItem => ({
        id: `verb:${verb.id}`,
        group: "Commands",
        label: verb.label,
        icon: verb.icon,
        context: verb.surfaces[0]?.replace(/-/g, " "),
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
