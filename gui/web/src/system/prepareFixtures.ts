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
