import { describe, expect, it } from "vitest";
import type { MuteState } from "../utils/audio";
import {
  muteButtonLabel,
  muteButtonTitle,
  SAVED_MUTE_READ_ONLY,
  soloButtonLabel,
  soloButtonTitle,
} from "./trackMuteCopy";

describe("trackMuteCopy", () => {
  it("names the M and S buttons after the track", () => {
    expect(muteButtonLabel("Caleb")).toBe("Mute Caleb");
    expect(soloButtonLabel("Caleb")).toBe("Solo Caleb");
  });

  const states: MuteState[] = ["saved", "listen", "implied", "off"];

  it.each(
    states.flatMap((state) => [
      [state, true] as const,
      [state, false] as const,
    ]),
  )(
    "gives %s (editsMix=%s) a title starting with the action",
    (state, editsMix) => {
      const title = muteButtonTitle(state, editsMix);
      if (state === "saved" && !editsMix) {
        expect(title).toBe(SAVED_MUTE_READ_ONLY);
        return;
      }
      expect(
        title.startsWith("Mute (M)") || title.startsWith("Unmute (M)"),
      ).toBe(true);
    },
  );

  it("leads with the shortcut before what the state means", () => {
    expect(muteButtonTitle("saved", true)).toBe(
      "Unmute (M). Muted in the mix, for everyone and every export",
    );
    expect(muteButtonTitle("saved", false)).toBe(SAVED_MUTE_READ_ONLY);
    expect(muteButtonTitle("listen", true)).toBe(
      "Unmute (M). Muted for you only",
    );
    expect(muteButtonTitle("implied", true)).toBe(
      "Mute (M). Not muted: silent because you soloed another track, and only you hear it that way",
    );
    expect(muteButtonTitle("off", true)).toBe(
      "Mute (M). Mutes the track in the mix, for everyone",
    );
    expect(muteButtonTitle("off", false)).toBe(
      "Mute (M). Mutes the track for you only",
    );
  });

  it("titles the solo button by soloed state", () => {
    expect(soloButtonTitle(false)).toBe(
      "Solo (S). Solos the track for you only",
    );
    expect(soloButtonTitle(true)).toBe("Unsolo (S). Soloed for you only");
  });
});
