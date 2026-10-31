import { Button, DefItem, DefinitionList } from "../ui";
import type { InspectorSection } from "./InspectorSheet";
import {
  JoinType,
  LiveScrub,
  LiveTime,
  Mute,
  SeamAudition,
  Wave,
} from "./inspectorSheetFixtures";
import type { ScrubFieldProps } from "./ScrubField";

type ScrubSpec =
  | { variant?: "plain"; min?: number; max?: number; value: number | null }
  | {
      variant: "track" | "level";
      min: number;
      max: number;
      value: number | null;
    };

const scrub = (
  label: string,
  spec: ScrubSpec &
    Pick<ScrubFieldProps, "unit" | "step" | "decimals" | "defaultValue">,
) => <LiveScrub label={label} onCommit={() => {}} {...spec} />;

export const CLIP_SECTIONS: readonly InspectorSection[] = [
  {
    id: "timing",
    title: "Timing",
    rows: [
      {
        id: "start",
        label: "Start",
        control: scrub("Start", {
          value: 724.3,
          unit: "s",
          step: 0.01,
          min: 0,
        }),
      },
      {
        id: "end",
        label: "End",
        control: scrub("End", { value: 743.1, unit: "s", step: 0.01, min: 0 }),
      },
      {
        id: "length",
        label: "Length",
        control: scrub("Length", {
          value: 18.8,
          unit: "s",
          step: 0.01,
          min: 0.1,
        }),
      },
    ],
  },
  {
    id: "fades",
    title: "Fades",
    rows: [
      {
        id: "in",
        label: "Fade in",
        control: scrub("Fade in", {
          value: 120,
          unit: "ms",
          step: 1,
          min: 0,
          max: 2000,
          defaultValue: 0,
        }),
      },
      {
        id: "out",
        label: "Fade out",
        control: scrub("Fade out", {
          value: 0,
          unit: "ms",
          step: 1,
          min: 0,
          max: 2000,
          defaultValue: 0,
        }),
      },
    ],
  },
  {
    id: "audio",
    title: "Audio",
    rows: [
      {
        id: "gain",
        label: "Gain",
        control: scrub("Gain", {
          value: -2.5,
          unit: "dB",
          step: 0.1,
          min: -24,
          max: 12,
          defaultValue: 0,
        }),
      },
    ],
  },
];

export const TRACK_SECTIONS: readonly InspectorSection[] = [
  {
    id: "mix",
    rows: [
      {
        id: "level",
        label: "Level",
        control: scrub("Level", {
          variant: "level",
          value: -6,
          unit: "dB",
          step: 0.5,
          min: -60,
          max: 6,
          defaultValue: 0,
        }),
      },
      { id: "mute", label: "Track", control: <Mute /> },
    ],
  },
];

export const ENVELOPE_POINT_SECTIONS: readonly InspectorSection[] = [
  {
    id: "point",
    rows: [
      {
        id: "time",
        label: "Time",
        control: scrub("Time", {
          value: 724.31,
          unit: "s",
          step: 0.01,
          min: 0,
        }),
      },
      {
        id: "level",
        label: "Level",
        control: scrub("Level", {
          variant: "level",
          value: 0.5,
          unit: "×",
          step: 0.01,
          min: 0,
          max: 1.5,
          defaultValue: 1,
        }),
      },
    ],
  },
];

export const RANGE_SECTIONS: readonly InspectorSection[] = [
  {
    id: "range",
    title: "Range",
    rows: [
      { id: "start", control: <LiveTime label="Range start" start={724.3} /> },
      { id: "end", control: <LiveTime label="Range end" start={743.1} /> },
    ],
  },
];

export const WORD_TIMING_SECTIONS: readonly InspectorSection[] = [
  {
    id: "wave",
    rows: [{ id: "wave", control: <Wave /> }],
  },
  {
    id: "timing",
    title: "Timing",
    rows: [
      {
        id: "start",
        label: "Start",
        control: scrub("Start", {
          value: 731.42,
          unit: "s",
          step: 0.01,
          decimals: 2,
          min: 731.0,
          max: 732.2,
        }),
      },
      {
        id: "end",
        label: "End",
        control: scrub("End", {
          value: 731.88,
          unit: "s",
          step: 0.01,
          decimals: 2,
          min: 731.1,
          max: 732.4,
        }),
      },
      { id: "hear", control: <Button>Hear</Button> },
    ],
  },
];

export const SEAM_SECTIONS: readonly InspectorSection[] = [
  {
    id: "offset",
    title: "Offset",
    rows: [
      {
        id: "offset",
        label: "Offset",
        control: scrub("Offset", {
          variant: "track",
          value: 12,
          unit: "ms",
          step: 1,
          decimals: 1,
          min: -200,
          max: 200,
          defaultValue: 0,
        }),
      },
      { id: "ab", control: <SeamAudition /> },
    ],
  },
  {
    id: "join",
    title: "Join",
    rows: [
      { id: "type", label: "Type", control: <JoinType /> },
      {
        id: "length",
        label: "Length",
        control: scrub("Join length", {
          value: 40,
          unit: "ms",
          step: 1,
          min: 0,
          max: 500,
          defaultValue: 40,
        }),
      },
    ],
  },
];

export const LONG_SECTIONS: readonly InspectorSection[] = [
  ...CLIP_SECTIONS,
  ...SEAM_SECTIONS,
  ...RANGE_SECTIONS,
  ...TRACK_SECTIONS,
];

export const AUTO_REDUCTION_SECTIONS: readonly InspectorSection[] = [
  {
    id: "regions",
    rows: [
      {
        id: "regions",
        control: (
          <div role="group" aria-label="Automatic regions in this clip">
            <Button aria-pressed>
              Automatic reduction Timeline 5.000 to 6.000 s
            </Button>
          </div>
        ),
      },
    ],
  },
  {
    id: "actions",
    rows: [
      {
        id: "restore",
        control: <Button variant="primary">Restore original audio</Button>,
      },
      {
        id: "refresh",
        control: <Button>Refresh regions</Button>,
      },
    ],
  },
];

export const COMMENT_SECTIONS: readonly InspectorSection[] = [
  {
    id: "facts",
    rows: [
      {
        id: "facts",
        control: (
          <div className="inspector edit-sheet-part">
            <DefinitionList>
              <DefItem label="Time">
                <Button>12:04</Button>
              </DefItem>
              <DefItem label="Author">Maya</DefItem>
              <DefItem label="Status">Open</DefItem>
            </DefinitionList>
          </div>
        ),
      },
      {
        id: "body",
        control: <p className="inspector-body">Needs a tighter open</p>,
      },
    ],
  },
  {
    id: "reply",
    rows: [
      {
        id: "reply",
        control: (
          <div className="comment-reply-compose">
            <input aria-label="Reply to comment" placeholder="Reply…" />
            <Button>Reply</Button>
          </div>
        ),
      },
    ],
  },
  {
    id: "resolve",
    rows: [
      { id: "resolve", control: <Button variant="primary">Resolve</Button> },
    ],
  },
];
