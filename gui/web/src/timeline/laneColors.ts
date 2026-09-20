const DIALOGUE_COLORS = [
  "var(--clip-dialogue-0)",
  "var(--clip-dialogue-1)",
  "var(--clip-dialogue-2)",
];

export function laneColor(role: string, trackIndex: number): string {
  if (role === "music") {
    return "var(--clip-music)";
  }
  if (role === "sfx") {
    return "var(--clip-sfx)";
  }
  return DIALOGUE_COLORS[trackIndex % DIALOGUE_COLORS.length];
}
