import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { RULER_HEIGHT } from "../utils/layout";
import { Clip } from "./Clip";
import { Lane, LaneItem } from "./Lane";
import { EPISODE_SECONDS, LANE_ROWS, stage } from "./laneFixtures";
import { laneRows } from "./laneMath";
import { Measured } from "./laneStoryHost";
import {
  Presence,
  type PresencePerson,
  type PresenceProps,
  type PresenceSelection,
} from "./Presence";
import { VOICE_PEAKS } from "./prepareFixtures";
import { usePresenceDemo } from "./presenceStoryHost";
import { Ruler } from "./Ruler";

const PX_PER_SECOND = 24;
const noop = () => undefined;

const LANES = LANE_ROWS.slice(0, 2);
/** The ruler is the only thing above the lanes here. */
const ROWS = laneRows(LANES, RULER_HEIGHT);

const PEOPLE: readonly PresencePerson[] = [
  { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 8 },
  { id: "anneke", name: "Anneke de Vries", colorIndex: 1, playhead: 10.5 },
];

const SELECTIONS: readonly PresenceSelection[] = [
  {
    id: "maya-sel",
    personId: "maya",
    laneId: "maya",
    start: 8,
    end: 17,
    colorIndex: 0,
  },
  {
    id: "anneke-sel",
    personId: "anneke",
    laneId: "anneke",
    start: 6,
    end: 11,
    colorIndex: 1,
  },
];

type StackProps = Pick<PresenceProps, "followed"> & {
  people?: readonly PresencePerson[];
  selections?: readonly PresenceSelection[];
  playhead?: number;
  /** Adds a person whose line is this many px left of the time column's right edge. */
  fromRight?: number;
  /** Whether this viewer's link can open where someone is: false draws plain marks, as on a guest link. */
  canGoTo?: boolean;
};

/** The overlay over a ruler and two lanes, in one time column, as the Edit timeline stacks them. */
function Stack(props: StackProps) {
  return (
    <div style={stage}>
      <Measured>{(width) => <Column {...props} width={width} />}</Measured>
    </div>
  );
}

function Column({
  people = PEOPLE,
  selections,
  followed,
  playhead = 3,
  fromRight,
  canGoTo = true,
  width,
}: StackProps & { width: number }) {
  const all = useMemo(
    () =>
      fromRight === undefined
        ? people
        : [
            ...people,
            {
              id: "edge",
              name: "Edgar Stone",
              colorIndex: 4,
              playhead: (width - fromRight) / PX_PER_SECOND,
            },
          ],
    [people, fromRight, width],
  );
  const [went, setWent] = useState<readonly string[]>([]);
  const { flags, hit, covered } = usePresenceDemo({
    people: all,
    followed,
    start: 0,
    pxPerSecond: PX_PER_SECOND,
    width,
    duration: EPISODE_SECONDS,
  });
  const jumpable = useMemo(
    () => new Set(canGoTo ? all.map((person) => person.id) : []),
    [canGoTo, all],
  );
  return (
    <div
      data-went={went.join(",")}
      style={{ position: "relative", inlineSize: width }}
    >
      <Ruler
        start={0}
        pxPerSecond={PX_PER_SECOND}
        width={width}
        duration={EPISODE_SECONDS}
        playhead={playhead}
        covered={covered}
        onSeek={noop}
      />
      {LANES.map((row) => (
        <Lane
          key={row.id}
          name={row.name}
          colorIndex={row.colorIndex}
          start={0}
          pxPerSecond={PX_PER_SECOND}
          width={width}
        >
          {row.clips.map((clip) => (
            <LaneItem key={clip.id} at={clip.at} duration={clip.duration}>
              <Clip
                id={clip.id}
                name={clip.name}
                colorIndex={row.colorIndex}
                start={clip.at}
                duration={clip.duration}
                pxPerSecond={PX_PER_SECOND}
                peaks={VOICE_PEAKS}
                onSelect={noop}
              />
            </LaneItem>
          ))}
        </Lane>
      ))}
      <Presence
        flags={flags}
        selections={selections}
        rows={ROWS}
        followed={followed}
        start={0}
        pxPerSecond={PX_PER_SECOND}
        width={width}
        hit={hit}
        jumpable={jumpable}
        onGoTo={(id) => setWent((now) => [...now, id])}
        onGroup={noop}
      />
    </div>
  );
}

const meta: Meta<typeof Stack> = {
  title: "System/Presence",
  component: Stack,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Other people on the Edit timeline (design-system element 32, spec-edit OVL-PRESENCE). A remote playhead is a 1 px line in the person's colour from the ruler down through the lanes, with a 16 px flag of their first initial on the ruler: right of the line, or left of it when it would pass the window's right edge. People whose press areas would overlap (24 px square for a mouse, 44 px for a finger) share one neutral `+N` flag at the leftmost line, which counts people (`99+` past 99); each line stays drawn in its own colour. A ruler label a flag touches fades out (opacity only, `--motion-hover`, instant under reduced motion) through the Ruler's `covered` prop and comes back when the flag moves on. A remote selection is a 1 px outline in their colour with no fill, around their span in one lane; where the span runs past the window that side has no edge. The person you follow (`followed`) draws no selection and no flag.\n\nIt takes the flags `presenceFlags` makes (with `hit`, the press area's side), plus `selections`, `rows` from `laneRows`, and the ruler's `start`, `pxPerSecond` and `width`. It is one sibling of the ruler, the marker lane and the lanes in their time column, because the ruler clips its children. The line sits within half a pixel of the ruler's own playhead. `presence/presencePeople` makes the people from session clients.\n\nThe overlay is hidden from assistive tech and takes no pointer, except a flag of someone the viewer can jump to (`jumpable`): that flag is a button whose own box is the press area (at least `hit` square), out of the tab order, with `touch-action: manipulation`. A single flag calls `onGoTo`; a `+N` flag calls `onGroup` with the pill's box, and its host draws the menu beside the overlay, not in it. A flag nobody can jump to (a guest link) is a plain mark. The people list is the keyboard and screen-reader way to go to someone. The line and the outline are borders, so they stay under forced colours, where the outline turns dashed, the flags take a border and the hover ring is an outline.\n\nThe 16 px flag is the one avatar that is not a `System/Person` size.\n\n**Motion.** The label fade only; a line moves as often as the person's position arrives.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Stack>;

export const TwoRemote: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Timeline position" }),
    ).toBeVisible();
    await expect(
      canvasElement.querySelectorAll(".sys-presence-line"),
    ).toHaveLength(2);
    await expect(
      canvasElement.querySelectorAll(".sys-presence-flag"),
    ).toHaveLength(2);
    await expect(
      canvasElement.querySelectorAll(".sys-presence button"),
    ).toHaveLength(2);
  },
};

export const FlagOverLabel: Story = {
  args: {
    people: [{ id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 5 }],
  },
  play: async ({ canvasElement }) => {
    const label = [
      ...canvasElement.querySelectorAll(".sys-ruler-tick-label"),
    ].find((el) => el.textContent === "0:05");
    await expect(label).toHaveAttribute("data-covered");
    await expect(
      canvasElement.querySelectorAll(".sys-ruler-tick-label[data-covered]"),
    ).toHaveLength(1);
  },
};

export const Cluster: Story = {
  args: {
    people: [
      { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 12 },
      { id: "anneke", name: "Anneke de Vries", colorIndex: 1, playhead: 12.4 },
      { id: "leo", name: "Leo Brandt", colorIndex: 2, playhead: 12.7 },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".sys-presence-line"),
    ).toHaveLength(3);
    const flags = canvasElement.querySelectorAll(".sys-presence-flag");
    await expect(flags).toHaveLength(1);
    await expect(flags[0]).toHaveTextContent("+3");
  },
};

export const EdgeFlipsLeft: Story = {
  args: { people: [], fromRight: 6 },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".sys-presence-hit"),
    ).toHaveAttribute("data-side", "left");
  },
};

export const GuestPlainMarks: Story = {
  args: { canGoTo: false },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".sys-presence-flag"),
    ).toHaveLength(2);
    await expect(
      canvasElement.querySelector(".sys-presence button"),
    ).toBeNull();
  },
};

export const RemoteSelection: Story = {
  args: { selections: SELECTIONS },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".sys-presence-sel"),
    ).toHaveLength(2);
  },
};

export const FollowedHidden: Story = {
  args: { selections: SELECTIONS, followed: "maya" },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector('[data-person="maya"]'),
    ).toBeNull();
    await expect(
      canvasElement.querySelectorAll(".sys-presence-line"),
    ).toHaveLength(1);
    await expect(
      canvasElement.querySelectorAll(".sys-presence-sel"),
    ).toHaveLength(1);
  },
};
