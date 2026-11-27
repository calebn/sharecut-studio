/**
 * A handheld phone's short screen side, in CSS px. Equal to
 * `SHORT_VIEWPORT_PX` (hooks/useShortViewport): Pixel 8 Pro and 9 Pro XL
 * report about 448, a Galaxy S24 Ultra up to 480; tablets start at 600.
 */
export const HANDHELD_SHORT_SIDE_PX = 480;

/** The primary pointer is a finger, not a mouse or trackpad. */
export const COARSE_POINTER_MQ = "(pointer: coarse)";

/** A coarse pointer on a screen whose short side is at most the handheld threshold. */
export function isHandheldScreen(
  coarse: boolean,
  screenWidth: number,
  screenHeight: number,
): boolean {
  return (
    coarse && Math.min(screenWidth, screenHeight) <= HANDHELD_SHORT_SIDE_PX
  );
}

/**
 * Whether this device is a handheld phone, in either orientation. The screen,
 * not the viewport, is measured, so the soft keyboard cannot flip it. Read in
 * script, not with `max-device-height`, which WebKit may report as the
 * portrait value after a rotation. False without `matchMedia` or `screen`.
 */
export function readHandheld(): boolean {
  if (
    typeof globalThis.matchMedia !== "function" ||
    typeof globalThis.screen === "undefined"
  ) {
    return false;
  }
  const { width, height } = globalThis.screen;
  return isHandheldScreen(
    globalThis.matchMedia(COARSE_POINTER_MQ).matches,
    width,
    height,
  );
}
