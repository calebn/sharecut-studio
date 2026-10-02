import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeMeterFrame } from "../audio/meterFrameLoop";
import { type MeterState, SILENT_METER, stepMeter } from "../audio/metering";
import {
  playbackTrackClipped,
  setPlaybackTrackClipped,
} from "../audio/playbackClipLatches";
import {
  playbackMeterSource,
  subscribePlaybackMeterSource,
} from "../audio/playbackMeterSource";
import { METER_PUBLISH_INTERVAL_MS } from "../audio/usePeakMeter";
import { useDaw } from "../state/useDaw";
import { ClipLed } from "../ui/ClipLed";
import { Icon } from "../ui/Icon";
import { LevelMeter } from "../ui/LevelMeter";
import { keepActivationKeys } from "./trackHeaderKeys";

export function TrackPlaybackMeter({
  trackId,
  label,
}: {
  trackId: string;
  label: string;
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
  const state = useRef<MeterState>(SILENT_METER);
  const [levels, setLevels] = useState(SILENT_METER);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    state.current = {
      ...SILENT_METER,
      clipped: playbackTrackClipped(trackId, projectEpoch),
    };
    setLevels(state.current);
    setAvailable(false);
  }, [projectEpoch, trackId]);

  useEffect(() => {
    if (!playing || !source) {
      setAvailable(false);
      state.current = { ...SILENT_METER, clipped: state.current.clipped };
      setLevels(state.current);
      return;
    }
    setAvailable(false);
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let last: number | null = null;
    let published = Number.NEGATIVE_INFINITY;
    let wasAvailable = false;
    return subscribeMeterFrame((now) => {
      const samples = source.read(trackId);
      const nextAvailable = samples !== null;
      if (nextAvailable !== wasAvailable) {
        wasAvailable = nextAvailable;
        setAvailable(nextAvailable);
      }
      const prev = state.current;
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
  }, [playing, source, trackId]);

  return (
    <div
      className="track-playback-meter"
      data-available={available}
      title="Sample peak at track output, before premix and master"
    >
      <LevelMeter
        {...levels}
        label={`${label} playback level`}
        size="sm"
        showClipIndicator={false}
        valueText={
          !available
            ? playing
              ? `Playback level unavailable${levels.clipped ? ". Clipping detected" : ""}`
              : `Playback stopped${levels.clipped ? ". Clipping detected" : ""}`
            : levels.clipped && !Number.isFinite(levels.levelDb)
              ? "Clipping detected"
              : undefined
        }
      />
      <button
        type="button"
        className="track-clip-clear"
        aria-label={`Clear clip light for ${label}`}
        title={
          levels.clipped
            ? "Clipping detected. Clear clip light"
            : "No clipping detected"
        }
        disabled={!levels.clipped}
        onKeyDown={keepActivationKeys}
        onClick={(event) => {
          event.stopPropagation();
          setPlaybackTrackClipped(trackId, false);
          state.current = { ...state.current, clipped: false };
          setLevels(state.current);
        }}
      >
        {levels.clipped ? (
          <Icon name="warning" title="Clipping detected" size={12} />
        ) : (
          <ClipLed lit={false} />
        )}
      </button>
    </div>
  );
}
