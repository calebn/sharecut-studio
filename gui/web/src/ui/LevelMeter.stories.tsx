import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo } from "react";
import { type FrameReader, usePeakMeter } from "../audio/usePeakMeter";
import { Button, LevelMeter } from "./index";
import { createScriptedMeterSource } from "./meterStorySource";

const meta: Meta<typeof LevelMeter> = {
  title: "Atoms/LevelMeter",
  component: LevelMeter,
  tags: ["autodocs"],
  argTypes: {
    levelDb: {
      control: { type: "range", min: -60, max: 0, step: 0.5 },
      description: "Current peak level, dBFS",
    },
  },
  args: {
    label: "Input level",
  },
};

export default meta;
type Story = StoryObj<typeof LevelMeter>;

export const Quiet: Story = {
  args: { levelDb: -42, showNumeric: true, showScale: true },
};

export const HealthySpeech: Story = {
  args: {
    levelDb: -12,
    peakHoldDb: -9,
    showNumeric: true,
    showScale: true,
  },
};

export const Hot: Story = {
  args: {
    levelDb: -4,
    peakHoldDb: -2.5,
    showNumeric: true,
    showScale: true,
  },
};

export const Clipped: Story = {
  args: {
    levelDb: -0.5,
    peakHoldDb: 0,
    clipped: true,
    showNumeric: true,
    showScale: true,
  },
};

export const Vertical: Story = {
  args: {
    levelDb: -9,
    peakHoldDb: -6,
    clipped: false,
    orientation: "vertical",
    showNumeric: true,
    showScale: true,
  },
};

export const Compact: Story = {
  args: {
    levelDb: -14,
    peakHoldDb: -11,
    size: "sm",
  },
  parameters: {
    docs: {
      description: {
        story:
          "The roster-row size: no scale, no numeric readout, clip LED only. " +
          "On narrow phones this is the whole meter.",
      },
    },
  },
};

function useScriptedFrames(): FrameReader {
  const source = useMemo(() => createScriptedMeterSource(), []);
  useEffect(() => {
    source.attach();
    return () => source.dispose();
  }, [source]);
  return source.read;
}

function LiveSimulationDemo() {
  const take = usePeakMeter(useScriptedFrames());
  return (
    <div className="stack">
      <p style={{ color: "var(--color-text-secondary)", margin: 0 }}>
        Scripted take, looping every 16 s: room tone → speech → a laugh that
        clips at ~8 s → speech. The clip LED latches until cleared.
      </p>
      <LevelMeter
        label="Simulated input"
        levelDb={take.levelDb}
        peakHoldDb={take.peakHoldDb}
        clipped={take.clipped}
        showNumeric
        showScale
      />
      <div>
        <Button
          onClick={take.clearClip}
          disabledReason={take.clipped ? undefined : "No clipping to clear."}
        >
          Clear clip indicator
        </Button>
      </div>
      <LevelMeter
        label="Simulated input (vertical)"
        levelDb={take.levelDb}
        peakHoldDb={take.peakHoldDb}
        clipped={take.clipped}
        orientation="vertical"
        showScale
      />
    </div>
  );
}

export const LiveSimulation = {
  render: () => <LiveSimulationDemo />,
} satisfies Story;
