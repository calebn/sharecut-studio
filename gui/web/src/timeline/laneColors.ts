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
