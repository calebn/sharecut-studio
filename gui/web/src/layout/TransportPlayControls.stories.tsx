import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import type { TransportAvailability } from "../state/transportAvailability";
import { Pill, Timecode } from "../ui";
import { transportTimecode } from "../utils/time";
import { ListenHero } from "./ListenHero";
import { TransportFrame, TransportZone } from "./TransportFrame";
import { TransportPlayControls } from "./TransportPlayControls";

const meta: Meta<typeof TransportPlayControls> = {
  title: "Templates/TransportPlayControls",
  component: TransportPlayControls,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    availability: { togglePlay: undefined, stop: undefined },
    onTogglePlay: fn(),
    onStop: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof TransportPlayControls>;

function TransportPreview({
  initiallyPlaying = false,
  availability,
  phone = false,
  onTogglePlay,
  onStop,
}: {
  initiallyPlaying?: boolean;
  availability: TransportAvailability;
  phone?: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
}) {
  const [playing, setPlaying] = useState(initiallyPlaying);
  const [position, setPosition] = useState(12.5);
  const controls = (
    <TransportPlayControls
      playing={playing}
      availability={availability}
      onTogglePlay={() => {
        onTogglePlay();
        setPlaying((value) => !value);
      }}
      onStop={() => {
        onStop();
        setPlaying(false);
      }}
    />
  );
  if (phone) {
    return (
      <main className="mobile-listen">
        <ListenHero
          title="Episode 12: Field notes"
          playing={playing}
          controls={controls}
          timecode={<Timecode {...transportTimecode(position, 60)} />}
          scrubber={
            <input
              type="range"
              className="listen-scrub"
              min={0}
              max={60}
              step={0.01}
              value={position}
              aria-label="Scrub timeline"
              onChange={(event) => setPosition(Number(event.target.value))}
            />
          }
        />
      </main>
    );
  }
  return (
    <>
      <div className="daw-shell-transport">
        <TransportFrame playing={playing}>
          <TransportZone position="start">
            <h1>Episode 12: Field notes</h1>
          </TransportZone>
          <TransportZone position="center">{controls}</TransportZone>
          <TransportZone position="end">
            <Pill tone="ok">Mix up to date</Pill>
          </TransportZone>
        </TransportFrame>
      </div>
      <main aria-label="Stage" />
    </>
  );
}

export const Ready: Story = {
  render: (args) => <TransportPreview {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    await expect(canvas.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(args.onTogglePlay).toHaveBeenCalledOnce();
    await userEvent.click(
      canvas.getByRole("button", { name: "Stop playback" }),
    );
    await expect(canvas.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(args.onStop).toHaveBeenCalledOnce();
  },
};

export const Playing: Story = {
  render: (args) => <TransportPreview {...args} initiallyPlaying />,
};

export const EmptyProject: Story = {
  args: {
    availability: {
      togglePlay: "Import audio to play.",
      stop: "Import audio to play.",
    },
  },
  render: (args) => <TransportPreview {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Import audio to play.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Play" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(
      canvas.getByRole("button", { name: "Stop playback" }),
    ).toHaveAttribute("aria-disabled", "true");
  },
};

export const CompactPhone: Story = {
  render: (args) => <TransportPreview {...args} phone />,
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    await expect(canvas.getByRole("button", { name: "Pause" })).toBeVisible();
  },
};

export const PausedEmptyProject: Story = {
  decorators: [
    (Story) => (
      <>
        <div className="daw-shell-transport">
          <TransportFrame playing={false}>
            <TransportZone position="center">
              <Story />
            </TransportZone>
          </TransportFrame>
        </div>
        <main aria-label="Stage" />
      </>
    ),
  ],
  args: {
    playing: false,
    availability: { togglePlay: "Import audio to play.", stop: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Play" }),
    ).toHaveAccessibleDescription("Import audio to play.");
    await expect(
      canvas.getByRole("button", { name: "Stop playback" }),
    ).not.toHaveAttribute("aria-disabled");
    await expect(
      canvas.getByRole("button", { name: "Stop playback" }),
    ).not.toHaveAttribute("aria-describedby");
  },
};
