import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo } from "react";
import { type FrameReader, usePeakMeter } from "../audio/usePeakMeter";
import { dbToLinear } from "../utils/audio";
import { Avatar, LevelMeter } from "./index";

/**
 * Layout sketch, not a shipped component: how per-participant meters could
 * sit in the record room roster (issue #170). Rows reuse
 * `Roster.tsx`'s `<ul className="record-roster">` markup with `.cluster`
 * items; each row is an Avatar, a name and a compact LevelMeter driven by
 * `usePeakMeter`, the same loop `useInputPeakDb` runs on a real mic.
 */
function wander(seed: number, t: number): number {
  return (
    -18 +
    Math.sin(t * 5 + seed) * 3 +
    Math.sin(t * 11 + seed * 2) * 2 +
    Math.random() * 4
  );
}

function useParticipantFrames(
  seed: number,
  clipAt: number | null,
): FrameReader {
  return useMemo(() => {
    const frame = new Float32Array(1024);
    return () => {
      const t = performance.now() / 1000;
      let target = wander(seed, t);
      if (clipAt !== null && t % 20 > clipAt && t % 20 < clipAt + 0.4) {
        target = -0.3; // hot mic moment
      }
      const amp = dbToLinear(target);
      for (let i = 0; i < frame.length; i++) {
        frame[i] = amp * Math.sin((i / frame.length) * Math.PI * 6);
      }
      return frame;
    };
  }, [seed, clipAt]);
}

function RosterRow({
  name,
  colorIndex,
  seed,
  clipAt = null,
}: {
  name: string;
  colorIndex: number;
  seed: number;
  clipAt?: number | null;
}) {
  const levels = usePeakMeter(useParticipantFrames(seed, clipAt));
  return (
    <li className="cluster">
      <Avatar name={name} colorIndex={colorIndex} />
      <span>{name}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <LevelMeter
          label={`${name} input level`}
          levelDb={levels.levelDb}
          peakHoldDb={levels.peakHoldDb}
          clipped={levels.clipped}
          size="sm"
        />
      </div>
    </li>
  );
}

const meta: Meta = {
  title: "Molecules/ParticipantMeter",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Layout sketch (story-only, not in the library): LevelMeter in " +
          "`record-roster` rows for the record room (#170).",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

function Roster() {
  return (
    <div className="stack" style={{ maxWidth: "var(--measure)" }}>
      <ul className="record-roster">
        <RosterRow name="You (host)" colorIndex={0} seed={1} />
        <RosterRow name="Mara" colorIndex={3} seed={4} clipAt={12} />
        <RosterRow name="Dev" colorIndex={5} seed={9} />
      </ul>
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
