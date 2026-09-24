import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { Timecode } from "../ui";
import { transportTimecode } from "../utils/time";
import { ListenHero } from "./ListenHero";
import { TransportPlayControls } from "./TransportPlayControls";

/** The phone Listen screen's hero with static content. */
const meta: Meta<typeof ListenHero> = {
  title: "Templates/ListenHero",
  component: ListenHero,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof ListenHero>;

function Hero({ initiallyPlaying = false }: { initiallyPlaying?: boolean }) {
  const [playing, setPlaying] = useState(initiallyPlaying);
  const [position, setPosition] = useState(12.5);
  return (
    <main style={{ maxInlineSize: "24rem" }}>
      <ListenHero
        title="Episode 12: Field notes"
        playing={playing}
        controls={
          <TransportPlayControls
            playing={playing}
            onTogglePlay={() => setPlaying((value) => !value)}
            onStop={() => setPlaying(false)}
          />
        }
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
            onChange={(e) => setPosition(Number(e.target.value))}
          />
        }
        skipBack={
          <button
            type="button"
            onClick={() => setPosition((p) => Math.max(0, p - 15))}
          >
            −15s
          </button>
        }
        skipForward={
          <button
            type="button"
            onClick={() => setPosition((p) => Math.min(60, p + 15))}
          >
            +15s
          </button>
        }
      />
    </main>
  );
}

export const Default: Story = {
  render: () => <Hero />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    await expect(
      await canvas.findByRole("button", { name: "Pause" }),
    ).toBeTruthy();
    await expect(
      canvas.getByRole("heading", {
        level: 1,
        name: "Episode 12: Field notes",
      }),
    ).toBeTruthy();
  },
};

export const Playing: Story = { render: () => <Hero initiallyPlaying /> };
