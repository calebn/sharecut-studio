import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import type { MuteState } from "../utils/audio";
import { Clip } from "./Clip";
import { Lane, LaneItem } from "./Lane";
import { LANE_ROWS, type LaneRow, stage } from "./laneFixtures";
import { Measured } from "./laneStoryHost";
import { VOICE_PEAKS } from "./prepareFixtures";

const PX_PER_SECOND = 24;

type Look = { height?: number; mute?: MuteState; loading?: boolean };

type LanesProps = {
  rows?: readonly LaneRow[];
  looks?: readonly Look[];
  selected?: string;
  start?: number;
  pxPerSecond?: number;
  peaks?: boolean;
  /** A lane height override, which the lane holds to 72 through 240. */
  height?: number;
};

/** Lanes of clips with the selection a host would keep. */
function Lanes({
  rows = LANE_ROWS,
  looks = [],
  selected,
  start = 0,
  pxPerSecond = PX_PER_SECOND,
  peaks = true,
  height,
}: LanesProps) {
  const [picked, setPicked] = useState(selected);
  return (
    <div style={stage}>
      <Measured>
        {(width) =>
          rows.map((row, index) => (
            <Lane
              key={row.id}
              name={row.name}
              colorIndex={row.colorIndex}
              height={looks[index]?.height ?? height}
              mute={looks[index]?.mute}
              loading={looks[index]?.loading}
              start={start}
              pxPerSecond={pxPerSecond}
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
                    fadeIn={clip.fadeIn}
                    fadeOut={clip.fadeOut}
                    pxPerSecond={pxPerSecond}
                    peaks={peaks ? VOICE_PEAKS : undefined}
                    selected={picked === clip.id}
                    onSelect={setPicked}
                  />
                </LaneItem>
              ))}
            </Lane>
          ))
        }
      </Measured>
    </div>
  );
}

const meta: Meta<typeof Lanes> = {
  title: "System/Lane",
  component: Lanes,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "One track's stripe of the Edit timeline (design-system element 15a). A lane is 72 to 240 px tall (the host passes 104 on touch), tinted 6% in the track's colour behind its clips, with a 3 px edge in that colour on its inline start. It takes plain data: the window's `start` and `pxPerSecond`, its `width`, the track's `colorIndex` and `name`, and `LaneItem` children, each a `System/Clip` with its time `at` and `duration`; the lane works out where each stands, so a ruler, a marker lane and the lanes below it share one window and one formula. A clip wholly outside the window is not drawn. The lane is a group named `Track <name>` and owns no clip logic: selecting, trimming and fading stay with the clips.\n\nWhile peaks are on their way (`loading`) a flat line runs through the middle and the lane is `aria-busy`. A silent track (`mute` saved, listen or implied) sits on the muted track colour and says why in words, the same words as its header. A guest sees the same lane: what a guest may not do is a rule of the clip.\n\nThe lane takes no keys of its own; only its colour edge and loading line let the pointer through.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Lanes>;

export const Empty: Story = {
  args: { rows: [{ id: "joss", name: "Joss", colorIndex: 2, clips: [] }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Track Joss" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const ThreeTracks: Story = {
  args: {
    selected: "maya-2",
    looks: [{ height: 72 }, { height: 104 }, { height: 240 }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Track Music bed" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Maya, take 2" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const PeaksLoading: Story = {
  args: {
    peaks: false,
    looks: [{ loading: true }, { loading: true }, { loading: true }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Track Maya Okafor" }),
    ).toHaveAttribute("aria-busy", "true");
  },
};

export const Muted: Story = {
  args: {
    looks: [{ mute: "saved" }, { mute: "listen" }, { mute: "implied" }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Track Maya Okafor" }),
    ).toHaveAccessibleDescription("Muted in the mix");
    await expect(
      canvas.getByRole("group", { name: "Track Music bed" }),
    ).toHaveAccessibleDescription("Silent while another track is soloed");
  },
};
