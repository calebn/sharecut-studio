import { useEffect, useState } from "react";
import { applyFadeRecommendations, setEffectBypass } from "../../api";
import { runPointerCommand } from "../../commands/pointer";
import { seekTransport } from "../../commands/seek";
import { useTrackMetaMutation } from "../../hooks/useTrackMetaMutation";
import { ingestFiles, pickAudioFiles } from "../../ingest/ingestFiles";
import {
  canApplyPass12,
  canEditEnvelopes,
  canIngestMedia,
  canManageProjects,
  guestHearsMixOnly,
} from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { TrackFader } from "../../tracks/TrackFader";
import { TrackMuteSoloButtons } from "../../tracks/TrackMuteSoloButtons";
import { TrackPlaybackMeter } from "../../tracks/TrackPlaybackMeter";
import type { ProjectView, TrackView } from "../../types/project";
import {
  Button,
  CommandButton,
  DefItem,
  DefinitionList,
  FieldRow,
  InspectorSeekFooterView,
  Menu,
  MenuItem,
} from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { GUESTS_HEAR_FULL_MIX } from "../../utils/auditionModes";
import { formatEffectParams } from "../../utils/effectParams";
import { sortedVolumePoints } from "../../utils/envelopes";
import { playTimelineRange } from "../../utils/playRange";
import { splitSpeakersBlocker } from "../../utils/speakerSplit";
import { ModifierInspector } from "../ModifierInspector";

type EffectRow = ProjectView["effects_by_track"][string][number];

export function TrackInspector({
  track,
  effects,
}: {
  track: TrackView;
  effects: EffectRow[];
}) {
  const {
    projectPath,
    project,
    setSelection,
    setLayerVisible,
    layers,
    guestMode,
    shareCapabilities,
    setPlayUntilSec,
    setIsPlaying,
  } = useDaw((s) => ({
    projectPath: s.projectPath,
    project: s.project,
    setSelection: s.setSelection,
    setLayerVisible: s.setLayerVisible,
    layers: s.layers,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    setPlayUntilSec: s.setPlayUntilSec,
    setIsPlaying: s.setIsPlaying,
  }));
  const { busy, error, setError, run, saveMetaFields } = useTrackMetaMutation(
    track.id,
  );
  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mixOnly = guestHearsMixOnly(guestMode);
  const hostCanSplit = canManageProjects(projectPath);
  const splitBlocker = splitSpeakersBlocker(track, hostCanSplit);
  const [label, setLabel] = useState(track.label);
  const [speaker, setSpeaker] = useState(track.speaker ?? "");
  const [role, setRole] = useState(track.role);
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);

  useEffect(() => {
    setLabel(track.label);
    setSpeaker(track.speaker ?? "");
    setRole(track.role);
    setError(null);
  }, [track.id, track.label, track.speaker, track.role, setError]);

  const toggleBypass = async (index: number, bypass: boolean) => {
    await run(async () => {
      await setEffectBypass(projectPath, track.id, index, bypass);
    });
  };

  const smoothJoins = async () => {
    await run(async () => {
      await applyFadeRecommendations(projectPath, track.id);
    });
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

  const saveMeta = async () => {
    await saveMetaFields({
      label: label.trim() || track.id,
      role,
      speaker: speaker.trim() || undefined,
    });
  };

  const importAudio = async () => {
    const files = await pickAudioFiles(false);
    if (!files.length) {
      return;
    }
    await ingestFiles(files, { kind: "track", id: track.id });
  };

  return (
    <ModifierInspector
      badge="Track"
      title={track.label || track.id}
      subtitle={track.label && track.label !== track.id ? track.id : undefined}
      error={error}
      footer={
        <InspectorSeekFooterView
          seekLabel="Go to start"
          playLabel="Preview effects at track start"
          playDisabledReason={mixOnly ? GUESTS_HEAR_FULL_MIX : undefined}
          onSeek={() => void seekTransport(0)}
          onPlay={playFxAround}
        />
      }
    >
      <div className="track-sheet-mixer" role="group" aria-label="Track mixer">
        <div className="track-transport-btns">
          <TrackMuteSoloButtons trackId={track.id} />
        </div>
        <TrackFader track={track} />
        <TrackPlaybackMeter
          trackId={track.id}
          label={track.label || track.id}
          inspector
        />
        <Button
          aria-pressed={layers.showLevels}
          onClick={() => setLayerVisible("showLevels", !layers.showLevels)}
        >
          {layers.showLevels ? "Hide volume envelope" : "Show volume envelope"}
        </Button>
        <Button
          data-envelope-entry={track.id}
          onClick={() => {
            setSelection({ kind: "envelope", trackId: track.id });
          }}
        >
          {!canEditEnvelopes(projectPath, guestMode, shareCapabilities)
            ? "View volume envelope"
            : sortedVolumePoints(project?.envelopes, track.id).length
              ? "Edit volume envelope"
              : "Add volume envelope"}
        </Button>
      </div>
      {editable ? (
        <div className="modifier-footer-actions">
          <Menu
            open={trackMenuOpen}
            onOpenChange={setTrackMenuOpen}
            label="Track actions"
            trigger={(props) => <Button {...props}>Track actions</Button>}
          >
            <MenuItem
              disabledReason={busy ? BUSY_REASON : undefined}
              title="Apply the recommended fade at every join on this track"
              onSelect={() => {
                setTrackMenuOpen(false);
                void smoothJoins();
              }}
            >
              Smooth all joins
            </MenuItem>
          </Menu>
        </div>
      ) : null}
      {mayIngest ? (
        <>
          <DefinitionList>
            <DefItem label="Label">
              <FieldRow>
                <input
                  aria-label="Track label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onBlur={() => void saveMeta()}
                />
              </FieldRow>
            </DefItem>
            <DefItem label="Speaker">
              <FieldRow>
                <input
                  aria-label="Track speaker"
                  value={speaker}
                  onChange={(e) => setSpeaker(e.target.value)}
                  onBlur={() => void saveMeta()}
                />
              </FieldRow>
            </DefItem>
            <DefItem label="Role">
              <FieldRow>
                <select
                  aria-label="Track role"
                  value={role}
                  onChange={(e) => {
                    const nextRole = e.target.value;
                    setRole(nextRole);
                    void saveMetaFields({ role: nextRole });
                  }}
                >
                  <option value="dialogue">dialogue</option>
                  <option value="music">music</option>
                  <option value="sfx">sfx</option>
                  <option value="intro">intro</option>
                  <option value="outro">outro</option>
                </select>
              </FieldRow>
            </DefItem>
          </DefinitionList>
          <div className="modifier-footer-actions">
            <Button
              disabledReason={busy ? BUSY_REASON : undefined}
              onClick={() => void importAudio()}
            >
              {track.media_path ? "Replace audio…" : "Import audio…"}
            </Button>
            {hostCanSplit ? (
              <CommandButton
                commandId="track.splitSpeakers"
                args={{ trackId: track.id }}
                className="split-speakers-entry"
                disabledReason={
                  busy ? BUSY_REASON : (splitBlocker ?? undefined)
                }
              >
                Split speakers…
              </CommandButton>
            ) : null}
            <CommandButton
              commandId="track.remove"
              args={{ trackId: track.id }}
              variant="danger"
              disabledReason={busy ? BUSY_REASON : undefined}
            />
          </div>
          {hostCanSplit && splitBlocker ? (
            <p className="modifier-note">{splitBlocker}</p>
          ) : null}
        </>
      ) : (
        <DefinitionList>
          <DefItem label="Role">{track.role}</DefItem>
        </DefinitionList>
      )}
      <DefinitionList>
        <DefItem label="Stem">
          {track.stem_is_fresh === true
            ? "Up to date"
            : track.stem_is_fresh === false
              ? "Out of date"
              : "Unknown"}
        </DefItem>
        <DefItem label="Media">{track.media_path ?? "none"}</DefItem>
      </DefinitionList>
      {effects.length > 0 && (
        <>
          <h3>Effects</h3>
          <ul className="fx-chain-list">
            {effects.map((e, i) => {
              const bypassed = Boolean(e.bypass);
              return (
                <li
                  key={`${e.effect}-${i}`}
                  className={`fx-chain-item${bypassed ? " bypassed" : ""}`}
                >
                  <div className="fx-chain-main">
                    <span className="fx-chain-name">{e.effect}</span>
                    <span className="fx-chain-params">
                      {formatEffectParams(e.params, e.effect) ||
                        "Default settings"}
                    </span>
                    {e.warning ? (
                      <span className="fx-chain-warning" role="status">
                        {e.warning}
                      </span>
                    ) : null}
                  </div>
                  {editable ? (
                    <label className="fx-bypass-toggle">
                      <input
                        type="checkbox"
                        checked={bypassed}
                        disabled={busy}
                        aria-label={`Bypass ${e.effect}`}
                        onChange={(ev) =>
                          void toggleBypass(i, ev.target.checked)
                        }
                      />
                      Bypass
                    </label>
                  ) : (
                    <span className="fx-bypass-readonly">
                      {bypassed ? "bypassed" : "active"}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </ModifierInspector>
  );
}
