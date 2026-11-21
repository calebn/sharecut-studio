export type PlayheadSurface = "script" | "timeline";

type ScrollMode = "always" | "if-offscreen";
type PlayheadScroller = (mode?: ScrollMode) => boolean;

const scrollers = new Map<PlayheadSurface, PlayheadScroller>();

export const playheadScrollRegistry = {
  register: (surface: PlayheadSurface, scroll: PlayheadScroller) => {
    scrollers.set(surface, scroll);
    return () => {
      if (scrollers.get(surface) === scroll) scrollers.delete(surface);
    };
  },
  scrollAllToPlayhead: () => {
    let scrolled = false;
    for (const scroll of scrollers.values()) {
      if (scroll()) scrolled = true;
    }
    return scrolled;
  },
  /** Scrolls one surface only, so re-arming the timeline leaves the Script where it is. */
  scrollToPlayhead: (surface: PlayheadSurface, mode?: ScrollMode): boolean =>
    scrollers.get(surface)?.(mode) ?? false,
};
