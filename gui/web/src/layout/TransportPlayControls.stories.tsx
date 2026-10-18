import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
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
    onTogglePlay: fn(),
    onStop: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof TransportPlayControls>;

function TransportPreview({
  initiallyPlaying = false,
  disabledReason,
  phone = false,
  onTogglePlay,
  onStop,
}: {
  initiallyPlaying?: boolean;
  disabledReason?: string;
  phone?: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
}) {
  const [playing, setPlaying] = useState(initiallyPlaying);
  const [position, setPosition] = useState(12.5);
  const controls = (
    <TransportPlayControls
      playing={playing}
      disabledReason={disabledReason}
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
    await userEvent.click(canvas.getByRole("button", { name: "Stop" }));
    await expect(canvas.getByRole("button", { name: "Play" })).toBeVisible();
    await expect(args.onStop).toHaveBeenCalledOnce();
  },
};

export const Playing: Story = {
  render: (args) => <TransportPreview {...args} initiallyPlaying />,
};

export const EmptyProject: Story = {
  args: { disabledReason: "Import audio to play." },
  render: (args) => <TransportPreview {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Import audio to play.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Play" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(canvas.getByRole("button", { name: "Stop" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
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
