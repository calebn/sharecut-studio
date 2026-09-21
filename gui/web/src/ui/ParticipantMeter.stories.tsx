import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { Avatar } from "./index";
import { LevelMeter } from "./LevelMeter";
import { decayPeakHold, peakDbFromSamples } from "./metering";

/**
 * Composition example, not a shipped component: how per-participant meters
 * look in the record room roster (issue #170). Each row is an Avatar, a
 * name, a compact LevelMeter, and the latching clip LED. The record UI will
 * drive one of these per participant from `useInputPeakDb`.
 */
function ParticipantMeter({
  name,
  colorIndex,
  levelDb,
  peakHoldDb,
  clipped,
  speaking,
}: {
  name: string;
  colorIndex: number;
  levelDb: number;
  peakHoldDb: number;
  clipped: boolean;
  speaking: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2)",
        borderRadius: "var(--radius-md)",
        background: speaking
          ? "var(--color-bg-elevated)"
          : "var(--color-bg-surface)",
      }}
    >
      <Avatar name={name} colorIndex={colorIndex} />
      <span
        style={{
          minWidth: "8ch",
          fontSize: "var(--font-size-body)",
          color: "var(--color-text-primary)",
        }}
      >
        {name}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <LevelMeter
          label={`${name} input level`}
          levelDb={levelDb}
          peakHoldDb={peakHoldDb}
          clipped={clipped}
          size="sm"
        />
      </div>
    </div>
  );
}

function wander(seed: number, t: number): number {
  return (
    -18 +
    Math.sin(t * 5 + seed) * 3 +
    Math.sin(t * 11 + seed * 2) * 2 +
    Math.random() * 4
  );
}

function useParticipantLevels(seed: number, clipAt: number | null) {
  const [levelDb, setLevelDb] = useState(Number.NEGATIVE_INFINITY);
  const [peakHoldDb, setPeakHoldDb] = useState(Number.NEGATIVE_INFINITY);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    let holdDb = Number.NEGATIVE_INFINITY;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const t = now / 1000;
      let target = wander(seed, t);
      if (clipAt !== null && t % 20 > clipAt && t % 20 < clipAt + 0.4) {
        target = -0.3; // hot mic moment
      }
      const amp = Math.pow(10, target / 20);
      const frame = new Float32Array(1024);
      for (let i = 0; i < frame.length; i++) {
        frame[i] = amp * Math.sin((i / frame.length) * Math.PI * 6);
      }
      const peak = peakDbFromSamples(frame);
      holdDb = decayPeakHold(holdDb, peak, dt);
      setLevelDb(peak);
      setPeakHoldDb(holdDb);
      if (peak >= -1) setClipped(true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seed, clipAt]);

  return { levelDb, peakHoldDb, clipped };
}

const meta: Meta = {
  title: "Molecules/ParticipantMeter",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Story-local composition showing how LevelMeter wires into " +
          "per-participant rows for the record room (issue #170).",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

function Roster() {
  const host = useParticipantLevels(1, null);
  const guestA = useParticipantLevels(4, 12);
  const guestB = useParticipantLevels(9, null);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        maxWidth: "32rem",
      }}
    >
      <ParticipantMeter name="You (host)" colorIndex={0} {...host} speaking />
      <ParticipantMeter
        name="Mara"
        colorIndex={3}
        {...guestA}
        speaking={false}
      />
      <ParticipantMeter
        name="Dev"
        colorIndex={5}
        {...guestB}
        speaking={false}
      />
      <p style={{ color: "var(--color-text-secondary)", margin: 0 }}>
        Mara's mic runs hot every ~20 s and latches her clip LED — the state the
        record room must surface per take.
      </p>
    </div>
  );
}

export const RecordRoster: Story = {
  render: () => <Roster />,
};
