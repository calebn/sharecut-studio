import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { Timecode } from "../ui";
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
  disabled = false,
  disabledTitle,
  phone = false,
  onTogglePlay,
  onStop,
}: {
  initiallyPlaying?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  phone?: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
}) {
  const [playing, setPlaying] = useState(initiallyPlaying);
  const [position, setPosition] = useState(12.5);
  const controls = (
    <TransportPlayControls
      playing={playing}
      disabled={disabled}
      disabledTitle={disabledTitle}
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
      <div style={{ blockSize: "var(--transport-height)" }}>
        <TransportFrame playing={playing}>
          <TransportZone position="start">
            <h1>Episode 12: Field notes</h1>
          </TransportZone>
          <TransportZone position="center">
            <div className="transport-play">{controls}</div>
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
  args: { disabled: true, disabledTitle: "Import audio to play" },
  render: (args) => <TransportPreview {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Play" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Stop" })).toBeDisabled();
  },
};

export const CompactPhone: Story = {
  render: (args) => <TransportPreview {...args} phone />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    await expect(canvas.getByRole("button", { name: "Pause" })).toBeVisible();
  },
};
