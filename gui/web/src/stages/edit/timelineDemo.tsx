import { type CSSProperties, useState } from "react";
import { presenceAnchor, presenceAnchorProps } from "../../presence/anchors";
import { Clip } from "../../system/Clip";
import { Envelope, type EnvelopePointData } from "../../system/Envelope";
import { Lane, LaneItem } from "../../system/Lane";
import { ALL_KINDS, EPISODE_SECONDS, stage } from "../../system/laneFixtures";
import { laneRows, windowStartFor } from "../../system/laneMath";
import { Measured } from "../../system/laneStoryHost";
import { MarkerLane } from "../../system/MarkerLane";
import {
  Presence,
  type PresencePerson,
  type PresenceSelection,
} from "../../system/Presence";
import { VOICE_PEAKS } from "../../system/prepareFixtures";
import { Ruler } from "../../system/Ruler";
import { TrackHeader, type TrackHeaderForm } from "../../system/TrackHeader";
import { MARKER_ROW_HEIGHT, RULER_HEIGHT } from "../../utils/layout";
import { DEMO_TRACKS } from "./tracksFixtures";

/** The header column's width in px for each form: 10.5, 17.5 and 3.5 rem. */
const HEADER_PX: Record<TrackHeaderForm, number> = {
  default: 168,
  wide: 280,
  phone: 56,
};

/** Lane heights, so the presence rows are checked against lanes of different heights. */
const LANE_HEIGHTS = [72, 104, 72];

const LANES = DEMO_TRACKS.map((track, index) => ({
  ...track,
  height: LANE_HEIGHTS[index],
}));
const ROWS = laneRows(LANES);

/** The track whose lane carries the envelope. */
const ENVELOPE_TRACK = "maya";

const noop = () => undefined;

const frame: CSSProperties = { display: "flex", inlineSize: "100%" };

export type TimelineProps = {
  form?: TrackHeaderForm;
  pxPerSecond?: number;
  /** Seconds at the left edge of the time column; ignored when `fixedPlayhead` is set. */
  start?: number;
  /** The local playhead, in seconds. */
  playhead?: number;
  /** Phone: the playhead stays at the middle of the time column and the content scrolls under it. */
  fixedPlayhead?: boolean;
  people?: readonly PresencePerson[];
  selections?: readonly PresenceSelection[];
  followed?: string | null;
  selectedClip?: string;
  /** Maya's volume envelope, drawn over her lane; none draws no envelope. */
  envelope?: readonly EnvelopePointData[];
  envelopeSelected?: string | null;
};

/**
 * The Edit timeline stack as the parts compose it: a header column, and one
 * time column holding the ruler, the marker lane, the lanes and, over them
 * all, the presence overlay. Every part takes the same `start`,
 * `pxPerSecond` and `width`, so a time lands at the same x in all of them.
 */
export function Timeline({
  form = "default",
  pxPerSecond = 24,
  start = 0,
  playhead = 3,
  fixedPlayhead = false,
  people = [],
  selections,
  followed,
  selectedClip,
  envelope,
  envelopeSelected = null,
}: TimelineProps) {
  const [clip, setClip] = useState(selectedClip);
  const [points, setPoints] = useState(envelope);
  const [picked, setPicked] = useState(envelopeSelected);
  const headerPx = HEADER_PX[form];
  return (
    <div style={stage}>
      <Measured>
        {(whole) => {
          const width = Math.max(whole - headerPx, 1);
          const windowStart = fixedPlayhead
            ? windowStartFor(playhead, pxPerSecond, width)
            : start;
          return (
            <div style={frame}>
              <div style={{ flex: "none", inlineSize: headerPx }}>
                <div style={{ blockSize: RULER_HEIGHT + MARKER_ROW_HEIGHT }} />
                {LANES.map((track) => (
                  <div
                    key={track.id}
                    style={{ display: "flex", blockSize: track.height }}
                  >
                    <TrackHeader
                      id={track.id}
                      name={track.name}
                      colorIndex={track.colorIndex}
                      form={form}
                      level={track.level ?? 0}
                      onSelect={noop}
                      onMute={noop}
                      onSolo={noop}
                      onLevel={noop}
                    />
                  </div>
                ))}
              </div>
              <div
                data-testid="time-column"
                style={{
                  position: "relative",
                  flex: "none",
                  inlineSize: width,
                }}
              >
                <Ruler
                  start={windowStart}
                  pxPerSecond={pxPerSecond}
                  width={width}
                  duration={EPISODE_SECONDS}
                  playhead={playhead}
                  anchorProps={presenceAnchorProps(presenceAnchor("ruler"))}
                  onSeek={noop}
                />
                <MarkerLane
                  markers={ALL_KINDS}
                  start={windowStart}
                  pxPerSecond={pxPerSecond}
                  width={width}
                  duration={EPISODE_SECONDS}
                  anchorProps={presenceAnchorProps(presenceAnchor("markers"))}
                  onSelect={noop}
                />
                {LANES.map((track) => (
                  <Lane
                    key={track.id}
                    name={track.name}
                    colorIndex={track.colorIndex}
                    height={track.height}
                    start={windowStart}
                    pxPerSecond={pxPerSecond}
                    width={width}
                    anchorProps={presenceAnchorProps(
                      presenceAnchor("track", track.id),
                    )}
                  >
                    {track.clips.map((item) => (
                      <LaneItem
                        key={item.name}
                        at={item.start}
                        duration={item.duration}
                      >
                        <Clip
                          {...item}
                          id={item.name}
                          colorIndex={track.colorIndex}
                          pxPerSecond={pxPerSecond}
                          peaks={VOICE_PEAKS}
                          room={{ before: 1, after: 1 }}
                          selected={clip === item.name}
                          onSelect={setClip}
                        />
                      </LaneItem>
                    ))}
                    {points && track.id === ENVELOPE_TRACK ? (
                      <Envelope
                        points={points}
                        trackName={track.name}
                        colorIndex={track.colorIndex}
                        start={windowStart}
                        pxPerSecond={pxPerSecond}
                        width={width}
                        height={track.height}
                        duration={EPISODE_SECONDS}
                        selected={picked}
                        onSelect={setPicked}
                        onMove={(id, change) =>
                          setPoints((now) =>
                            now?.map((point) =>
                              point.id === id
                                ? {
                                    ...point,
                                    time: change.timeSeconds ?? point.time,
                                    db: change.db ?? point.db,
                                  }
                                : point,
                            ),
                          )
                        }
                      />
                    ) : null}
                  </Lane>
                ))}
                <Presence
                  people={people}
                  selections={selections}
                  rows={ROWS}
                  followed={followed}
                  start={windowStart}
                  pxPerSecond={pxPerSecond}
                  width={width}
                />
              </div>
            </div>
          );
        }}
      </Measured>
    </div>
  );
}
