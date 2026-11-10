import { useEffect } from "react";
import { setEffectBypass } from "../../api";
import { executePointerCommand } from "../../commands/pointer";
import { roomToneBedBlocker } from "../../commands/roomToneBed";
import { useTrackMetaMutation } from "../../hooks/useTrackMetaMutation";
import { ingestFiles, pickAudioFiles } from "../../ingest/ingestFiles";
import {
  canApplyPass12,
  canEditMix,
  canIngestMedia,
  canManageProjects,
} from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import { TrackMuteSoloButtons } from "../../tracks/TrackMuteSoloButtons";
import { TrackPlaybackMeter } from "../../tracks/TrackPlaybackMeter";
import type { Selection, TrackView } from "../../types/project";
import { Button, CommandButton } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import {
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_STEP_DB,
  trackFaderDb,
} from "../../utils/audio";
import { formatEffectParams } from "../../utils/effectParams";
import { splitSpeakersBlocker } from "../../utils/speakerSplit";
import { note } from "./sheetNote";
import { TrackKindControl } from "./TrackKindControl";
import { TrackLevelNote } from "./TrackLevelNote";
import { AddTrackPerson, TrackPerson } from "./TrackPerson";
import { kindOf, roleForKind, TRACK_KINDS } from "./trackKind";
import { personId, useEpisodePeople } from "./trackPeople";

function roomToneRows(track: TrackView, disabledReason: string | undefined) {
  if (track.room_tone_kind === "recorded")
    return [
      {
        id: "roomTone",
        label: "Room tone",
        control: "Recorded for this track",
      },
    ];
  const extracted = track.room_tone_kind === "extracted";
  return [
    {
      id: "roomTone",
      label: "Room tone",
      control: extracted
        ? "Cut from this track's own quiet stretch"
        : "None. Fills use comfort noise.",
    },
    {
      id: "roomToneAction",
      control: (
        <CommandButton
          commandId={
            extracted ? "track.clearRoomTone" : "track.extractRoomTone"
          }
          className="track-sheet-action"
          args={{ trackId: track.id }}
          disabledReason={disabledReason}
        >
          {extracted ? "Remove extracted room tone" : "Extract room tone"}
        </CommandButton>
      ),
    },
  ];
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
    rangeArmed,
    rememberPerson,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    layers: s.layers,
    setLayerVisible: s.setLayerVisible,
    rangeArmed: s.rangeArmed,
    rememberPerson: s.rememberPerson,
  }));
  const trackId =
    selection?.kind === "track" || selection?.kind === "envelope"
      ? selection.trackId
      : null;
  const track = project?.tracks.find((t) => t.id === trackId);
  const { busy, error, setError, run, saveMetaFields, saveSpeaker } =
    useTrackMetaMutation(trackId ?? "");
  useEffect(() => {
    setError(null);
  }, [track?.id, track?.speaker, setError]);
  const people = useEpisodePeople(project?.tracks ?? []);
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
  const hostCanSplit = canManageProjects(projectPath);
  const splitBlocker = splitSpeakersBlocker(track, hostCanSplit);
  const busyReason = busy ? BUSY_REASON : undefined;
  const bedBlocker = roomToneBedBlocker(
    track,
    hostCanSplit,
    track.room_tone_kind === "extracted" ? "clear" : "extract",
  );

  const pickPerson = (speaker: string) => {
    if (busy) return;
    const leavingId = personId(track.speaker);
    const leaving = project?.tracks.some(
      (t) => t.id !== track.id && personId(t.speaker) === leavingId,
    )
      ? undefined
      : people.find((p) => p.id === leavingId);
    void saveSpeaker(speaker).then((refused) => {
      if (leaving && refused === undefined) rememberPerson(leaving);
    });
  };
  const addPerson = (speaker: string) =>
    busy ? BUSY_REASON : saveSpeaker(speaker);
  const voice = kindOf(track.role) === "voice";
  const hasPeople = people.length > 0;
  const personRows = !voice
    ? []
    : mayIngest
      ? [
          ...(hasPeople
            ? [
                {
                  id: "person",
                  control: (
                    <TrackPerson
                      track={track}
                      people={people}
                      onPick={pickPerson}
                    />
                  ),
                },
              ]
            : []),
          {
            id: "addPerson",
            control: (
              <AddTrackPerson
                track={track}
                people={people}
                onPick={addPerson}
              />
            ),
          },
        ]
      : track.speaker
        ? [{ id: "person", label: "Person", control: track.speaker }]
        : [];

  const kindRow = {
    id: "kind",
    label: "Kind",
    control: mayIngest ? (
      <TrackKindControl
        role={track.role}
        disabledReason={busyReason}
        onPick={(kind) => {
          const role = roleForKind(track.role, kind);
          if (role) void saveMetaFields({ role });
        }}
      />
    ) : (
      TRACK_KINDS.find((k) => k.kind === kindOf(track.role))?.label
    ),
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

  const importAudio = async () => {
    const files = await pickAudioFiles(false);
    if (!files.length) return;
    await ingestFiles(files, { kind: "track", id: track.id });
  };

  return [
    {
      id: "track",
      rows: [
        ...personRows,
        kindRow,
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
        ...(voice && hostCanSplit && track.media_path
          ? roomToneRows(track, busyReason ?? bedBlocker ?? undefined)
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
  ];
}
