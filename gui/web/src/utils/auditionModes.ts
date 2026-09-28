import type { AuditionMode } from "../types/session";

export type AuditionModeDef = {
  id: AuditionMode;
  label: string;
  title: string;
};

/**
 * Audition mode segmented-control rows (`transport.audition`), shared by
 * `TransportBar`'s desktop/collapsed groups so the labels never drift apart.
 */
export const AUDITION_MODES: readonly AuditionModeDef[] = [
  {
    id: "mix",
    label: "Full mix",
    title: "All tracks mixed, with edits and effects",
  },
  {
    id: "fx",
    label: "Edited stems",
    title: "Each track with edits and effects",
  },
  {
    id: "raw",
    label: "Original",
    title: "Source audio, without edits or effects",
  },
];

/** Shown when a share guest is locked to Full mix (`guestHearsMixOnly`). */
export const GUESTS_HEAR_FULL_MIX = "Guests listen in Full mix";
