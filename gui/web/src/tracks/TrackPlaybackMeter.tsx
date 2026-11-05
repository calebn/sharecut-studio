import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeMeterFrame } from "../audio/meterFrameLoop";
import { type MeterState, SILENT_METER, stepMeter } from "../audio/metering";
import {
  playbackTrackClipped,
  setPlaybackTrackClipped,
  subscribePlaybackClipLatches,
} from "../audio/playbackClipLatches";
import {
  playbackMeterSource,
  subscribePlaybackMeterSource,
} from "../audio/playbackMeterSource";
import { METER_PUBLISH_INTERVAL_MS } from "../audio/usePeakMeter";
import { useDaw } from "../state/useDaw";
import { ClipLed } from "../ui/ClipLed";
import { useDisabledReasonNote } from "../ui/disabledReason";
import { Icon } from "../ui/Icon";
import { LevelMeter } from "../ui/LevelMeter";
import { keepActivationKeys } from "./trackHeaderKeys";

const NO_CLIPPING_REASON = "No clipping to clear.";

export function TrackPlaybackMeter({
  trackId,
  label,
  inspector = false,
}: {
  trackId: string;
  label: string;
  inspector?: boolean;
}) {
  const { projectEpoch, playing } = useDaw((s) => ({
    projectEpoch: s.projectEpoch,
    playing: s.isPlaying && s.sourcePreview === null,
  }));
  const source = useSyncExternalStore(
    subscribePlaybackMeterSource,
    playbackMeterSource,
    playbackMeterSource,
  );
  const clipped = useSyncExternalStore(
    subscribePlaybackClipLatches,
    () => playbackTrackClipped(trackId, projectEpoch),
    () => false,
  );
  const state = useRef<MeterState>(SILENT_METER);
  const [levels, setLevels] = useState(SILENT_METER);
  const [run, setRun] = useState({ playing, source, trackId, projectEpoch });
  if (
    run.playing !== playing ||
    run.source !== source ||
    run.trackId !== trackId ||
    run.projectEpoch !== projectEpoch
  ) {
    setRun({ playing, source, trackId, projectEpoch });
  }
  const [availability, setAvailability] = useState<{
    run: typeof run;
    value: boolean;
  } | null>(null);
  const available =
    playing &&
    source !== null &&
    availability?.run === run &&
    availability.value;

  useEffect(() => {
    state.current = {
      ...SILENT_METER,
      clipped: playbackTrackClipped(trackId, projectEpoch),
    };
    setLevels(state.current);
  }, [projectEpoch, trackId]);

  useEffect(() => {
    if (!playing || !source) {
      state.current = { ...SILENT_METER, clipped: state.current.clipped };
      setLevels(state.current);
      return;
    }
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let last: number | null = null;
    let published = Number.NEGATIVE_INFINITY;
    let wasAvailable = false;
    return subscribeMeterFrame((now) => {
      const samples = source.read(trackId);
      const nextAvailable = samples !== null;
      if (nextAvailable !== wasAvailable) {
        wasAvailable = nextAvailable;
        setAvailability({ run, value: nextAvailable });
      }
      const prev = {
        ...state.current,
        clipped: playbackTrackClipped(trackId, projectEpoch),
      };
      const analysed = stepMeter(
        prev,
        samples ?? [],
        last === null ? 0 : now - last,
      );
      last = now;
      const next = motion?.matches
        ? { ...prev, clipped: analysed.clipped }
        : analysed;
      state.current = next;
      if (next.clipped) setPlaybackTrackClipped(trackId, true);
      if (
        next.clipped !== prev.clipped ||
        now - published >= METER_PUBLISH_INTERVAL_MS
      ) {
        published = now;
        setLevels(next);
      }
    });
  }, [playing, source, trackId, projectEpoch, run]);

  const inspectorReason =
    inspector && !clipped ? NO_CLIPPING_REASON : undefined;
  const { note: clearNote, describedBy: clearDescribedBy } =
    useDisabledReasonNote(inspectorReason);
  return (
    <div
      className={`track-playback-meter${inspector ? " track-playback-meter--inspector" : ""}`}
      data-available={available}
      title="Sample peak at track output, before premix and master"
    >
      <LevelMeter
        {...levels}
        clipped={clipped}
        label={`${label} playback level`}
        size="sm"
        showClipIndicator={false}
        valueText={
          !available
            ? playing
              ? `Playback level unavailable${clipped ? ". Clipping detected" : ""}`
              : `Playback stopped${clipped ? ". Clipping detected" : ""}`
            : clipped && !Number.isFinite(levels.levelDb)
              ? "Clipping detected"
              : undefined
        }
      />
      {!inspector && (
        <span className="track-clip-status" aria-hidden="true">
          <ClipLed lit={clipped} />
        </span>
      )}
      <button
        type="button"
        className={`track-clip-clear${inspector ? " ui-control" : ""}`}
        aria-label={`Clear clip light for ${label}`}
        title={
          clipped
            ? "Clipping detected. Clear clip light"
            : "No clipping detected"
        }
        disabled={inspector ? undefined : !clipped}
        aria-disabled={inspectorReason ? true : undefined}
        {...clearDescribedBy}
        onKeyDown={keepActivationKeys}
        onClick={(event) => {
          event.stopPropagation();
          if (!clipped) return;
          setPlaybackTrackClipped(trackId, false);
          state.current = { ...state.current, clipped: false };
          setLevels(state.current);
        }}
      >
        {clipped ? (
          <Icon name="warning" title="Clipping detected" size={12} />
        ) : (
          <ClipLed lit={false} />
        )}
        {inspector && "Clear clip light"}
      </button>
      {clearNote}
    </div>
  );
}
