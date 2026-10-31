const DIALOGUE_COLORS = [
  "var(--color-clip-dialogue-0)",
  "var(--color-clip-dialogue-1)",
  "var(--color-clip-dialogue-2)",
];

export function laneColor(role: string, trackIndex: number): string {
  if (role === "music") {
    return "var(--color-clip-music)";
  }
  if (role === "sfx") {
    return "var(--color-clip-sfx)";
  }
  return DIALOGUE_COLORS[trackIndex % DIALOGUE_COLORS.length];
}

const MUSIC_COLOR_INDEX = 4;
const SFX_COLOR_INDEX = 5;

/**
 * The presence-palette index (0 to 7) that names the same family as
 * `laneColor`: dialogue tracks take the first three in turn, music and sound
 * effects each have their own. The stage track header colours its avatar with
 * it.
 */
export function laneColorIndex(role: string, trackIndex: number): number {
  if (role === "music") {
    return MUSIC_COLOR_INDEX;
  }
  if (role === "sfx") {
    return SFX_COLOR_INDEX;
  }
  return trackIndex % DIALOGUE_COLORS.length;
}
