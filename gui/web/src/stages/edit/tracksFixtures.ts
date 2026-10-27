import type { ClipProps } from "../../system/Clip";

export const PX_PER_SECOND = 24;

type DemoClip = Pick<
  ClipProps,
  "name" | "start" | "duration" | "fadeIn" | "fadeOut" | "mutedRegions"
>;

export type DemoTrack = {
  id: string;
  name: string;
  colorIndex: number;
  clips: readonly DemoClip[];
  level?: number;
  muted?: boolean;
  solo?: boolean;
  rebuilding?: boolean;
};

export const DEMO_TRACKS: readonly DemoTrack[] = [
  {
    id: "maya",
    name: "Maya Okafor",
    colorIndex: 0,
    level: -3,
    clips: [
      {
        name: "Maya, intro",
        start: 0.5,
        duration: 6,
        fadeIn: 120,
        fadeOut: 300,
      },
      {
        name: "Maya, take 2",
        start: 8,
        duration: 9,
        fadeOut: 500,
        mutedRegions: [{ start: 3, end: 4.5 }],
      },
    ],
  },
  {
    id: "anneke",
    name: "Anneke de Vries",
    colorIndex: 1,
    level: 0,
    clips: [
      { name: "Anneke, answer", start: 6.5, duration: 10, fadeIn: 200 },
      { name: "Anneke, aside", start: 18, duration: 1.6 },
    ],
  },
  {
    id: "music",
    name: "Music bed",
    colorIndex: 4,
    level: -12,
    clips: [
      { name: "Theme", start: 0, duration: 20, fadeIn: 1000, fadeOut: 2000 },
    ],
  },
];
