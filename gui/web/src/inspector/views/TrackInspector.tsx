import { useEffect, useState } from "react";
import { setEffectBypass, setTrackMetaCommand } from "../../api";
import { execute } from "../../commands/execute";
import { currentDocumentSeq } from "../../document/cursor";
import { revertOptimisticIfUnchanged } from "../../document/optimisticRevert";
import { patchTrackMeta } from "../../document/projectPatch";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { ingestFiles, pickAudioFiles } from "../../ingest/ingestFiles";
import {
  canApplyPass12,
  canIngestMedia,
  guestHearsMixOnly,
} from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { TrackFader } from "../../tracks/TrackFader";
import { TrackMuteSoloButtons } from "../../tracks/TrackMuteSoloButtons";
import type { ProjectView, TrackView } from "../../types/project";
import {
  Button,
  CommandButton,
  DefItem,
  DefinitionList,
  FieldRow,
} from "../../ui";
import { playTimelineRange } from "../../utils/playRange";
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
    guestMode,
    shareCapabilities,
    setPlayheadSec,
    setPlayUntilSec,
    setIsPlaying,
    setProject,
  } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    setPlayheadSec: s.setPlayheadSec,
    setPlayUntilSec: s.setPlayUntilSec,
    setIsPlaying: s.setIsPlaying,
    setProject: s.setProject,
  }));
  const { busy, error, setError, run } = useProjectMutation();
  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mixOnly = guestHearsMixOnly(guestMode);
  const [label, setLabel] = useState(track.label);
  const [speaker, setSpeaker] = useState(track.speaker ?? "");
  const [role, setRole] = useState(track.role);

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

  const playFxAround = () => {
    void execute("transport.audition", { mode: "fx" }, { skipWhen: true });
    playTimelineRange({
      start: 0,
      end: 0,
      padSec: 1.5,
      setPlayheadSec,
      setPlayUntilSec,
      setIsPlaying,
    });
  };

  const saveMetaFields = async (
    fields: Partial<{
      label: string;
      role: string;
      speaker: string | undefined;
    }>,
  ) => {
    const prev = useDawStore.getState().project;
    const seqAtStart = currentDocumentSeq();
    if (prev) {
      setProject(patchTrackMeta(prev, track.id, fields));
    }
    await run(async () => {
      try {
        await setTrackMetaCommand(projectPath, track.id, fields);
      } catch (e) {
        if (prev) {
          revertOptimisticIfUnchanged(prev, seqAtStart);
        }
        throw e;
      }
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
        <div className="modifier-footer-actions">
          <Button variant="link" onClick={() => setPlayheadSec(0)}>
            Seek start
          </Button>
          <Button
            variant="link"
            disabled={mixOnly}
            title={mixOnly ? "Guests listen in Mix" : undefined}
            onClick={playFxAround}
          >
            Play FX around start
          </Button>
        </div>
      }
    >
      <div className="track-sheet-mixer" role="group" aria-label="Track mixer">
        <div className="track-transport-btns">
          <TrackMuteSoloButtons trackId={track.id} />
        </div>
        <TrackFader track={track} />
        <p className="track-sheet-gain">
          For volume over time, drag Levels points on the timeline, then edit
          the selected point in the inspector.
        </p>
      </div>
      {mayIngest ? (
        <>
          <DefinitionList>
            <DefItem label="Label">
              <FieldRow>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onBlur={() => void saveMeta()}
                />
              </FieldRow>
            </DefItem>
            <DefItem label="Speaker">
              <FieldRow>
                <input
                  value={speaker}
                  onChange={(e) => setSpeaker(e.target.value)}
                  onBlur={() => void saveMeta()}
                />
              </FieldRow>
            </DefItem>
            <DefItem label="Role">
              <FieldRow>
                <select
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
            <Button disabled={busy} onClick={() => void importAudio()}>
              {track.media_path ? "Replace audio…" : "Import audio…"}
            </Button>
            <CommandButton
              commandId="track.remove"
              args={{ trackId: track.id }}
              variant="danger"
              disabled={busy}
            >
              Remove track
            </CommandButton>
          </div>
        </>
      ) : (
        <DefinitionList>
          <DefItem label="ID">{track.id}</DefItem>
          <DefItem label="Role">{track.role}</DefItem>
        </DefinitionList>
      )}
      <DefinitionList>
        <DefItem label="Stem">
          {track.stem_is_fresh === true
            ? "fresh"
            : track.stem_is_fresh === false
              ? "stale"
              : "unknown"}
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
                    <code className="fx-chain-params">
                      {JSON.stringify(e.params)}
                    </code>
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
