import { suggestPendingEdit } from "../../api";
import { presenceAnchor, presenceAnchorProps } from "../../presence/anchors";
import { canSuggestOrNudge } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { PendingEditView } from "../../types/project";
import { Button } from "../../ui";
import { clipsForTrack, timelinePointToSource } from "../../utils/timebase";

export function EmptyInspector({
  unmappable,
  onSelectPending,
}: {
  unmappable: PendingEditView[];
  onSelectPending: (edit: PendingEditView) => void;
}) {
  const {
    project,
    projectPath,
    guestMode,
    shareCapabilities,
    playheadSec,
    sessionRegion,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    playheadSec: s.playheadSec,
    sessionRegion: s.sessionRegion,
  }));
  const canSuggest = canSuggestOrNudge(
    projectPath,
    guestMode,
    shareCapabilities,
  );
  const dialogueTrack =
    project?.tracks.find((t) => t.role === "dialogue")?.id ??
    project?.tracks[0]?.id;

  const onSuggestCut = async () => {
    if (!dialogueTrack || !project) {
      return;
    }
    const clips = clipsForTrack(project.clips.tracks, dialogueTrack);
    const tlStart = sessionRegion?.start_sec ?? Math.max(0, playheadSec);
    const tlEnd =
      sessionRegion?.end_sec ?? Math.max(tlStart + 1, playheadSec + 2);
    const start = timelinePointToSource(clips, tlStart) ?? tlStart;
    const end =
      timelinePointToSource(clips, Math.max(tlEnd - 1e-6, tlStart)) ?? tlEnd;
    if (!(end > start)) {
      return;
    }
    await suggestPendingEdit(
      projectPath,
      dialogueTrack,
      start,
      end,
      "guest:suggest",
    );
  };

  return (
    <aside
      className="inspector"
      {...presenceAnchorProps(presenceAnchor("inspector"))}
    >
      <h2>Inspector</h2>
      <p style={{ color: "var(--text-dim)" }}>
        Click a clip, edit, track header, chapter marker, or Levels envelope
        point.
      </p>
      {canSuggest && dialogueTrack && (
        <p>
          <Button variant="primary" onClick={() => void onSuggestCut()}>
            Suggest cut
          </Button>
        </p>
      )}
      {unmappable.length > 0 && (
        <>
          <h2>Unmapped pending</h2>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: "var(--font-size-caption)",
            }}
          >
            {unmappable.length} edit(s) fall in removed material and cannot be
            drawn on the timeline.
          </p>
          <ul className="unmapped-list">
            {unmappable.map((e) => (
              <li key={e.id}>
                <Button variant="link" onClick={() => onSelectPending(e)}>
                  {e.type}: {e.reason ?? e.id}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
