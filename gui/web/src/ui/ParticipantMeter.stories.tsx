import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo } from "react";
import { type FrameReader, usePeakMeter } from "../audio/usePeakMeter";
import { Avatar, LevelMeter } from "./index";
import { createParticipantMeterSource } from "./meterStorySource";

function useParticipantFrames(
  seed: number,
  clipAt: number | null,
): FrameReader {
  const source = useMemo(
    () => createParticipantMeterSource(seed, clipAt),
    [seed, clipAt],
  );
  useEffect(() => {
    source.attach();
    return () => source.dispose();
  }, [source]);
  return source.read;
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

export const RecordRoster = {
  render: () => <Roster />,
} satisfies Story;
