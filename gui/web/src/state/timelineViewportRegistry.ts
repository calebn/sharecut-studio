export type VisualPan = Readonly<{
  geometry: Readonly<{
    scrollLeft: number;
    lineOffsetPx: number;
    zoomPxPerSec: number;
  }>;
  scrollLeft: number;
  zoomPxPerSec: number;
  playheadSec: number;
  seekRevision: number;
  projectPath: string;
}>;

/** Mounted timeline elements are ephemeral and never part of reactive DAW state. */
let timelineElement: HTMLElement | null = null;
let lanesElement: HTMLElement | null = null;
let leadPx = 0;
let visualPan: VisualPan | null = null;

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
  getVisualPan: () => visualPan,
  setVisualPan: (pan: VisualPan | null) => {
    visualPan = pan;
  },
  clear: () => {
    timelineElement = null;
    lanesElement = null;
    leadPx = 0;
    visualPan = null;
  },
};
