import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
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
  onTogglePlay,
  onStop,
}: {
  initiallyPlaying?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  onTogglePlay: () => void;
  onStop: () => void;
}) {
  const [playing, setPlaying] = useState(initiallyPlaying);
  return (
    <>
      <div style={{ blockSize: "var(--transport-height)" }}>
        <TransportFrame playing={playing} collapsed>
          <TransportZone position="center">
            <div className="transport-play">
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
            </div>
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
  render: (args) => <TransportPreview {...args} />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
