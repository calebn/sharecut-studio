import type { HeadphonesRule } from "../system/joinSheetModel";

/** Android's own tablet line is a 600 dp smallest width; a phone is under it. */
export const PHONE_SCREEN_MAX_SHORT_SIDE = 599;

export type HeadphonesEnv = { coarsePrimary: boolean; screenShortSide: number };

/**
 * The screen, unlike the window, does not change with
 * resizing or rotation, so a narrow laptop window keeps the gate. A zero
 * screen (jsdom, no display) is not a phone.
 */
export function headphonesRule(env: HeadphonesEnv): HeadphonesRule {
  return env.coarsePrimary &&
    env.screenShortSide > 0 &&
    env.screenShortSide <= PHONE_SCREEN_MAX_SHORT_SIDE
    ? "choice"
    : "required";
}

export function readHeadphonesEnv(win: Window = window): HeadphonesEnv {
  const coarsePrimary =
    typeof win.matchMedia === "function" &&
    win.matchMedia("(pointer: coarse)").matches;
  return {
    coarsePrimary,
    screenShortSide: Math.min(win.screen.width, win.screen.height),
  };
}
