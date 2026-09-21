import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import { Button } from "./index";
import { LevelMeter } from "./LevelMeter";
import { DEFAULT_CLIP_DB, decayPeakHold, peakDbFromSamples } from "./metering";

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

/**
 * Scripted take: room tone, speech, a laugh that clips, more speech.
 * Drives the same { levelDb, peakHoldDb, clipped, clearClip } shape that
 * `useInputPeakDb` returns, so this story previews the real wiring.
 */
function scriptedDb(tSec: number): number {
  const cyc = tSec % 16;
  if (cyc < 2) return -48 + Math.random() * 4;
  if (cyc < 8) return -16 + Math.sin(cyc * 7) * 4 + Math.random() * 5;
  if (cyc < 8.5) return -0.5 + Math.random() * 1.2;
  return -16 + Math.sin(cyc * 6.3) * 4 + Math.random() * 5;
}

function useSimulatedTake() {
  const [levelDb, setLevelDb] = useState(Number.NEGATIVE_INFINITY);
  const [peakHoldDb, setPeakHoldDb] = useState(Number.NEGATIVE_INFINITY);
  const [clipped, setClipped] = useState(false);
  const sim = useRef({
    holdDb: Number.NEGATIVE_INFINITY,
    start: 0,
    last: 0,
  });

  useEffect(() => {
    sim.current.start = performance.now();
    sim.current.last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const s = sim.current;
      const dt = now - s.last;
      s.last = now;
      // Synthesize a 2048-sample frame around the scripted level so the
      // story exercises the same peak detector the mic path will use.
      const target = scriptedDb((now - s.start) / 1000);
      const amp = target <= -60 ? 0 : Math.pow(10, target / 20);
      const frame = new Float32Array(2048);
      for (let i = 0; i < frame.length; i++) {
        frame[i] = amp * Math.sin((i / frame.length) * Math.PI * 8);
      }
      const peak = peakDbFromSamples(frame);
      s.holdDb = decayPeakHold(s.holdDb, peak, dt);
      setLevelDb(peak);
      setPeakHoldDb(s.holdDb);
      if (peak >= DEFAULT_CLIP_DB) setClipped(true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return {
    levelDb,
    peakHoldDb,
    clipped,
    clearClip: () => setClipped(false),
  };
}

function LiveSimulationDemo() {
  const take = useSimulatedTake();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
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
        <Button onClick={take.clearClip} disabled={!take.clipped}>
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

export const LiveSimulation: Story = {
  render: () => <LiveSimulationDemo />,
};
