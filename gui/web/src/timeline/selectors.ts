/** Stable DOM hooks shared by timeline views and browser geometry checks. */
export const timelineTestIds = {
  ruler: "timeline-ruler",
  lane: "timeline-lane",
  envelope: "timeline-envelope",
  clip: "timeline-clip",
  moveGhost: "timeline-move-ghost",
  trimGhost: "timeline-trim-ghost",
  trimOut: "timeline-trim-out",
  waveform: "timeline-waveform",
  waveformTile: "timeline-waveform-tile",
  snapTick: "timeline-snap-tick",
  muteRegion: "timeline-mute-region",
} as const satisfies Record<string, string>;
