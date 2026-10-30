import type { Meta, StoryObj } from "@storybook/react-vite";
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
};

/** The overlay over a ruler and two lanes, in one time column, as the Edit timeline stacks them. */
function Stack({
  people = PEOPLE,
  selections,
  followed,
  playhead = 3,
}: StackProps) {
  return (
    <div style={stage}>
      <Measured>
        {(width) => (
          <div style={{ position: "relative", inlineSize: width }}>
            <Ruler
              start={0}
              pxPerSecond={PX_PER_SECOND}
              width={width}
              duration={EPISODE_SECONDS}
              playhead={playhead}
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
              people={people}
              selections={selections}
              rows={ROWS}
              followed={followed}
              start={0}
              pxPerSecond={PX_PER_SECOND}
              width={width}
            />
          </div>
        )}
      </Measured>
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
          "Other people on the Edit timeline (design-system element 32, spec-edit OVL-PRESENCE). A remote playhead is a 1 px line in the person's colour from the ruler down through the lanes, with a 16 px flag of their first initial on the ruler: right of the line, or left of it when it would pass the window's right edge. A remote selection is a 1 px outline in their colour with no fill, around their span in one lane; where the span runs past the window that side has no edge. The person you follow (`followed`) draws nothing.\n\nIt takes plain data (`people`, `selections`, `rows` from `laneRows`, and the ruler's `start`, `pxPerSecond` and `width`) and is one sibling of the ruler, the marker lane and the lanes in their time column, because the ruler clips its children. The line sits within half a pixel of the ruler's own playhead. `presence/presencePeople` makes the people from session clients.\n\nThe overlay takes no pointer and is hidden from assistive tech: who is here is for the people list to say. The line and the outline are borders, so they stay under forced colours, where the outline turns dashed.\n\nThe 16 px flag is the one avatar that is not a `System/Person` size.\n\n**Motion.** None; a line moves as often as the person's position arrives.",
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
