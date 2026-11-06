export type PlayheadSurface = "script" | "timeline";

const scrollers = new Map<PlayheadSurface, () => boolean>();

export const playheadScrollRegistry = {
  register: (surface: PlayheadSurface, scroll: () => boolean) => {
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
};
