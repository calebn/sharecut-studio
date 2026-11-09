import { type KeyboardEvent, useEffect, useState } from "react";
import { applyFadeRecommendations, setEffectBypass } from "../../api";
import {
  executePointerCommand,
  runPointerCommand,
} from "../../commands/pointer";
import { seekTransport } from "../../commands/seek";
import { useTrackMetaMutation } from "../../hooks/useTrackMetaMutation";
import { ingestFiles, pickAudioFiles } from "../../ingest/ingestFiles";
import { RelatedCommands } from "../../inspector/RelatedCommands";
import {
  canApplyPass12,
  canEditMix,
  canIngestMedia,
  canManageProjects,
  guestHearsMixOnly,
} from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import { TrackMuteSoloButtons } from "../../tracks/TrackMuteSoloButtons";
import { TrackPlaybackMeter } from "../../tracks/TrackPlaybackMeter";
import type { Selection } from "../../types/project";
import { Button, CommandButton, InspectorSeekFooterView } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import {
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_STEP_DB,
  trackFaderDb,
} from "../../utils/audio";
import { GUESTS_HEAR_FULL_MIX } from "../../utils/auditionModes";
import { formatEffectParams } from "../../utils/effectParams";
import { playTimelineRange } from "../../utils/playRange";
import { splitSpeakersBlocker } from "../../utils/speakerSplit";
import { note } from "./sheetNote";
import { TrackLevelNote } from "./TrackLevelNote";

const ROLES = ["dialogue", "music", "sfx", "intro", "outro"] as const;

function stemText(fresh: boolean | null | undefined): string {
  if (fresh === true) return "Up to date";
  if (fresh === false) return "Out of date";
  return "Unknown";
}

export function useTrackSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const {
    project,
    projectPath,
    guestMode,
    shareCapabilities,
    layers,
    setLayerVisible,
    setPlayUntilSec,
    setIsPlaying,
    rangeArmed,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    layers: s.layers,
    setLayerVisible: s.setLayerVisible,
    setPlayUntilSec: s.setPlayUntilSec,
    setIsPlaying: s.setIsPlaying,
    rangeArmed: s.rangeArmed,
  }));
  const trackId =
    selection?.kind === "track" || selection?.kind === "envelope"
      ? selection.trackId
      : null;
  const track = project?.tracks.find((t) => t.id === trackId);
  const { busy, error, setError, run, saveMetaFields } = useTrackMetaMutation(
    trackId ?? "",
  );
  const [label, setLabel] = useState(track?.label ?? "");
  const [speaker, setSpeaker] = useState(track?.speaker ?? "");
  const [role, setRole] = useState(track?.role ?? "dialogue");
  useEffect(() => {
    setLabel(track?.label ?? "");
    setSpeaker(track?.speaker ?? "");
    setRole(track?.role ?? "dialogue");
    setError(null);
  }, [track?.id, track?.label, track?.speaker, track?.role, setError]);
  if (trackId === null) return null;
  if (rangeArmed && selection?.kind === "track") return [];
  if (!track)
    return [
      {
        id: "gone",
        rows: [{ id: "gone", control: note("Track not found") }],
      },
    ];

  const effects = project?.effects_by_track[track.id] ?? [];
  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const mixEditable = canEditMix(projectPath, guestMode, shareCapabilities);
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mixOnly = guestHearsMixOnly(guestMode);
  const hostCanSplit = canManageProjects(projectPath);
  const splitBlocker = splitSpeakersBlocker(track, hostCanSplit);
  const busyReason = busy ? BUSY_REASON : undefined;

  const saveMeta = async () => {
    const next = {
      label: label.trim() || track.id,
      role,
      speaker: speaker.trim() || undefined,
    };
    if (
      next.label === track.label &&
      next.role === track.role &&
      next.speaker === (track.speaker ?? undefined)
    )
      return;
    await saveMetaFields(next);
  };

  const commitText = {
    onBlur: () => void saveMeta(),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") e.currentTarget.blur();
    },
  };

  const setLevel = async (db: number) => {
    setError(null);
    try {
      const result = await executePointerCommand("track.setVolume", {
        trackId: track.id,
        db,
      });
      if (result.status === "disabled") setError(result.reason);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const playFxAround = () => {
    runPointerCommand("transport.audition", { mode: "fx" });
    playTimelineRange({
      start: 0,
      end: 0,
      padSec: 1.5,
      setPlayheadSec: (sec) => void seekTransport(sec),
      setPlayUntilSec,
      setIsPlaying,
    });
  };

  const importAudio = async () => {
    const files = await pickAudioFiles(false);
    if (!files.length) return;
    await ingestFiles(files, { kind: "track", id: track.id });
  };

  return [
    {
      id: "track",
      rows: [
        ...(mayIngest
          ? [
              {
                id: "name",
                label: "Name",
                control: (
                  <input
                    className="track-sheet-field"
                    aria-label="Name"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    {...commitText}
                  />
                ),
              },
              {
                id: "speaker",
                label: "Speaker",
                control: (
                  <input
                    className="track-sheet-field"
                    aria-label="Speaker"
                    value={speaker}
                    onChange={(e) => setSpeaker(e.target.value)}
                    {...commitText}
                  />
                ),
              },
              {
                id: "role",
                label: "Role",
                control: (
                  <select
                    className="track-sheet-field"
                    aria-label="Role"
                    value={role}
                    onChange={(e) => {
                      setRole(e.target.value);
                      void saveMetaFields({ role: e.target.value });
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ),
              },
            ]
          : [{ id: "role", label: "Role", control: track.role }]),
        {
          id: "level",
          label: "Level",
          control: (
            <ScrubField
              label="Level"
              value={trackFaderDb(track)}
              unit="dB"
              step={FADER_STEP_DB}
              min={FADER_MIN_DB}
              max={FADER_MAX_DB}
              defaultValue={0}
              skipUnchanged
              readOnly={!mixEditable}
              onCommit={(db) => void setLevel(db)}
            />
          ),
        },
        {
          id: "levelNote",
          control: <TrackLevelNote track={track} editable={mixEditable} />,
        },
        {
          id: "mix",
          label: "Mute and solo",
          control: (
            <div className="track-transport-btns">
              <TrackMuteSoloButtons trackId={track.id} />
            </div>
          ),
        },
        {
          id: "meter",
          label: "Playback",
          control: (
            <TrackPlaybackMeter
              trackId={track.id}
              label={track.label || track.id}
              inspector
            />
          ),
        },
        {
          id: "envelope",
          control: (
            <Button
              aria-pressed={layers.showLevels}
              onClick={() => setLayerVisible("showLevels", !layers.showLevels)}
            >
              {layers.showLevels
                ? "Hide volume envelope"
                : "Show volume envelope"}
            </Button>
          ),
        },
        {
          id: "stem",
          label: "Stem",
          control: stemText(track.stem_is_fresh),
        },
        {
          id: "media",
          label: "Media",
          control: track.media_path ?? "none",
        },
        ...(mayIngest
          ? [
              {
                id: "audio",
                control: (
                  <Button
                    className="track-sheet-action"
                    disabledReason={busyReason}
                    onClick={() => void importAudio()}
                  >
                    {track.media_path ? "Replace audio…" : "Import audio…"}
                  </Button>
                ),
              },
              ...(hostCanSplit
                ? [
                    {
                      id: "split",
                      control: (
                        <CommandButton
                          commandId="track.splitSpeakers"
                          className="track-sheet-action"
                          args={{ trackId: track.id }}
                          disabledReason={
                            busyReason ?? splitBlocker ?? undefined
                          }
                        >
                          Split speakers…
                        </CommandButton>
                      ),
                    },
                    ...(splitBlocker
                      ? [{ id: "splitNote", control: note(splitBlocker) }]
                      : []),
                  ]
                : []),
            ]
          : []),
        ...(error
          ? [
              {
                id: "error",
                control: note(error, "alert"),
              },
            ]
          : []),
      ],
    },
    ...(effects.length > 0
      ? [
          {
            id: "effects",
            title: "Effects",
            rows: effects.map((e, i) => {
              const bypassed = Boolean(e.bypass);
              return {
                id: `fx-${i}`,
                label: e.effect,
                control: (
                  <div>
                    <p className="sys-inspector-note">
                      {formatEffectParams(e.params, e.effect) ||
                        "Default settings"}
                    </p>
                    {e.warning ? (
                      <p className="sys-inspector-note" role="status">
                        {e.warning}
                      </p>
                    ) : null}
                    {editable ? (
                      <label className="track-sheet-bypass">
                        <input
                          type="checkbox"
                          checked={bypassed}
                          disabled={busy}
                          aria-label={`Bypass ${e.effect}`}
                          onChange={(ev) =>
                            void run(() =>
                              setEffectBypass(
                                projectPath,
                                track.id,
                                i,
                                ev.target.checked,
                              ),
                            )
                          }
                        />
                        Bypass
                      </label>
                    ) : (
                      <span>{bypassed ? "bypassed" : "active"}</span>
                    )}
                  </div>
                ),
              };
            }),
          },
        ]
      : []),
    {
      id: "tools",
      title: "Tools",
      rows: [
        ...(editable
          ? [
              {
                id: "smooth",
                control: (
                  <Button
                    className="track-sheet-action"
                    title="Apply the recommended fade at every join on this track"
                    disabledReason={busyReason}
                    onClick={() =>
                      void run(() =>
                        applyFadeRecommendations(projectPath, track.id),
                      )
                    }
                  >
                    Smooth all joins
                  </Button>
                ),
              },
            ]
          : []),
        {
          id: "seek",
          control: (
            <InspectorSeekFooterView
              seekLabel="Go to start"
              playLabel="Preview effects at track start"
              playDisabledReason={mixOnly ? GUESTS_HEAR_FULL_MIX : undefined}
              onSeek={() => void seekTransport(0)}
              onPlay={playFxAround}
            />
          ),
        },
      ],
    },
    ...(selection?.kind === "track"
      ? [
          {
            id: "related",
            rows: [
              {
                id: "related",
                control: <RelatedCommands selection={selection} />,
              },
            ],
          },
        ]
      : []),
  ];
}
