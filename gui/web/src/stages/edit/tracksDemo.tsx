import { type CSSProperties, useState } from "react";
import { Clip } from "../../system/Clip";
import { VOICE_PEAKS } from "../../system/prepareFixtures";
import {
  TrackHeader,
  type TrackHeaderForm,
  type TrackReorder,
} from "../../system/TrackHeader";
import type { MuteState } from "../../utils/audio";
import { DEMO_TRACKS, type DemoTrack, PX_PER_SECOND } from "./tracksFixtures";

const scroller: CSSProperties = { maxInlineSize: "100%", overflowX: "auto" };

const frame: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  inlineSize: "max-content",
  minInlineSize: "100%",
  border: "1px solid var(--color-border)",
};

const lane: CSSProperties = {
  position: "relative",
  blockSize: "4.5rem",
  inlineSize: `${21 * PX_PER_SECOND}px`,
  borderBlockEnd: "1px solid var(--color-border)",
  background: "var(--color-bg-sunken)",
};

type TracksProps = {
  tracks?: readonly DemoTrack[];
  form?: TrackHeaderForm;
  readOnly?: boolean;
  selectedClip?: string;
  selectedTrack?: string;
  reorder?: { id: string; state: TrackReorder };
};

/** Track headers and their lanes, with the mute, solo, level and selection state the host would keep. */
export function Tracks({
  tracks = DEMO_TRACKS,
  form = "default",
  readOnly = false,
  selectedClip,
  selectedTrack,
  reorder,
}: TracksProps) {
  const [state, setState] = useState(() =>
    Object.fromEntries(
      tracks.map((track) => [
        track.id,
        {
          level: track.level ?? 0,
          muted: track.muted ?? false,
          solo: track.solo ?? false,
        },
      ]),
    ),
  );
  const [clip, setClip] = useState(selectedClip);
  const [picked, setPicked] = useState(selectedTrack);
  const change = (id: string, patch: Partial<(typeof state)[string]>) =>
    setState((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const anySolo = Object.values(state).some((track) => track.solo);

  return (
    <div role="group" aria-label="Tracks" style={scroller}>
      <div style={frame}>
        {tracks.map((track) => {
          const now = state[track.id];
          const mute: MuteState = now.muted
            ? "saved"
            : anySolo && !now.solo
              ? "implied"
              : "off";
          const silent = mute === "saved" || mute === "implied";
          return (
            <div key={track.id} style={{ display: "flex" }}>
              <TrackHeader
                id={track.id}
                name={track.name}
                colorIndex={track.colorIndex}
                form={form}
                mute={mute}
                solo={now.solo}
                level={now.level}
                rebuilding={track.rebuilding}
                selected={picked === track.id}
                reorder={reorder?.id === track.id ? reorder.state : undefined}
                readOnly={readOnly}
                onSelect={setPicked}
                onMute={() => change(track.id, { muted: !now.muted })}
                onSolo={() => change(track.id, { solo: !now.solo })}
                onLevel={(_, level) => change(track.id, { level })}
              />
              <div
                style={{
                  ...lane,
                  filter: silent ? "grayscale(1)" : undefined,
                }}
              >
                {track.clips.map((item) => (
                  <div
                    key={item.name}
                    style={{
                      position: "absolute",
                      insetBlock: "var(--space-3)",
                      insetInlineStart: `${item.start * PX_PER_SECOND}px`,
                    }}
                  >
                    <Clip
                      {...item}
                      id={item.name}
                      colorIndex={track.colorIndex}
                      pxPerSecond={PX_PER_SECOND}
                      peaks={VOICE_PEAKS}
                      room={{ before: 1, after: 1 }}
                      selected={clip === item.name}
                      readOnly={readOnly}
                      onSelect={setClip}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
