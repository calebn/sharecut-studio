import { titleWithShortcut } from "../keymap/registry";
import type { MuteState } from "../utils/audio";

/** M on a track muted in the mix, for a guest who can't edit it. */
export const SAVED_MUTE_READ_ONLY =
  "Muted in the mix. Only the host and editors can unmute it";

/** Visible text on the M / S buttons. Accessible names must start with it (WCAG 2.5.3). */
export const MUTE_GLYPH = "M";
export const SOLO_GLYPH = "S";

/** Accessible name for the M button, naming the track it acts on. */
export function muteButtonLabel(label: string): string {
  return `Mute ${label}`;
}

/** Accessible name for the S button, naming the track it acts on. */
export function soloButtonLabel(label: string): string {
  return `Solo ${label}`;
}

const MUTE_ACTION: Record<MuteState, string> = {
  saved: "Unmute",
  listen: "Unmute",
  implied: "Mute",
  off: "Mute",
};

/** Tooltip for the M button: the action and its shortcut, then what it means. */
export function muteButtonTitle(state: MuteState, editsMix: boolean): string {
  const action = titleWithShortcut(MUTE_ACTION[state], "track.muteToggle");
  switch (state) {
    case "saved":
      return editsMix
        ? `${action}. Muted in the mix, for everyone and every export`
        : SAVED_MUTE_READ_ONLY;
    case "listen":
      return `${action}. Muted for you only`;
    case "implied":
      return `${action}. Not muted: silent because you soloed another track, and only you hear it that way`;
    case "off":
      return editsMix
        ? `${action}. Mutes the track in the mix, for everyone`
        : `${action}. Mutes the track for you only`;
  }
}

/** Tooltip for the S button: the action and its shortcut, then what it means. */
export function soloButtonTitle(solo: boolean): string {
  const action = titleWithShortcut(
    solo ? "Unsolo" : "Solo",
    "track.soloToggle",
  );
  return solo
    ? `${action}. Soloed for you only`
    : `${action}. Solos the track for you only`;
}
