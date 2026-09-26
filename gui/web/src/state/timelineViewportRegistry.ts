/** Mounted timeline elements are ephemeral and never part of reactive DAW state. */
let timelineElement: HTMLElement | null = null;
let lanesElement: HTMLElement | null = null;
let leadPx = 0;

export const timelineViewportRegistry = {
  getTimelineElement: () => timelineElement,
  setTimelineElement: (element: HTMLElement | null) => {
    timelineElement = element;
  },
  getLanesElement: () => lanesElement,
  setLanesElement: (element: HTMLElement | null) => {
    lanesElement = element;
  },
  getLeadPx: () => leadPx,
  setLeadPx: (value: number) => {
    leadPx = value;
  },
  clear: () => {
    timelineElement = null;
    lanesElement = null;
    leadPx = 0;
  },
};
