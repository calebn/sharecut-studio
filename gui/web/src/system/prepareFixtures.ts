import type { PickerPerson } from "./PersonPicker";

/** Plain, deterministic people for the Prepare stories. */
export const PEOPLE: readonly PickerPerson[] = [
  { id: "maya", name: "Maya Okafor", colorIndex: 0 },
  { id: "anneke", name: "Anneke de Vries", colorIndex: 1 },
  { id: "joss", name: "Joss", colorIndex: 2 },
];

/** Two people who share a name; the detail line tells them apart. */
export const ALIKE: readonly PickerPerson[] = [
  { id: "sam-a", name: "Sam", colorIndex: 3, detail: "Track 1, 5:11 of audio" },
  { id: "sam-b", name: "Sam", colorIndex: 4, detail: "Track 2, 2:40 of audio" },
];

/** A small fixed waveform for the source cards. */
export const VOICE_PEAKS: readonly number[] = [
  0.2, 0.5, 0.35, 0.7, 0.45, 0.9, 0.6, 0.3, 0.55, 0.8, 0.4, 0.25, 0.65, 0.5,
  0.35, 0.75, 0.3, 0.45, 0.6, 0.2,
];
