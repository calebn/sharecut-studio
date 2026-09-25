import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDaw } from "../state/useDaw";
import { selectUnmappedPending } from "../utils/edits";
import { AppliedEditInspector } from "./views/AppliedEditInspector";
import { ChapterInspector } from "./views/ChapterInspector";
import { ClipInspector } from "./views/ClipInspector";
import { CommentInspector } from "./views/CommentInspector";
import { EmptyInspector } from "./views/EmptyInspector";
import { EnvelopePointInspector } from "./views/EnvelopePointInspector";
import { PendingEditInspector } from "./views/PendingEditInspector";
import { SocialClipInspector } from "./views/SocialClipInspector";
import { TrackInspector } from "./views/TrackInspector";
import { TranscriptWordInspector } from "./views/TranscriptWordInspector";

export function Inspector() {
  const { project, selection, setSelection, setPlayheadSec } = useDaw((s) => ({
    project: s.project,
    selection: s.selection,
    setSelection: s.setSelection,
    setPlayheadSec: s.setPlayheadSec,
  }));

  if (!project) {
    return (
      <aside
        className="inspector"
        {...presenceAnchorProps(presenceAnchor("inspector"))}
      >
        <p>Loading episode…</p>
      </aside>
    );
  }

  const unmappable = selectUnmappedPending(project.pending_edits);

  if (!selection) {
    return (
      <EmptyInspector
        unmappable={unmappable}
        onSelectPending={(e) =>
          setSelection({
            kind: "pending",
            id: e.id,
            trackId: e.track_id,
          })
        }
      />
    );
  }

  switch (selection.kind) {
    case "clip": {
      const clip = Object.values(project.clips.tracks)
        .flat()
        .find((c) => c.id === selection.id);
      if (!clip) {
        return <aside className="inspector">Clip not found</aside>;
      }
      return <ClipInspector clip={clip} />;
    }
    case "pending": {
      const edit = project.pending_edits.find((e) => e.id === selection.id);
      if (!edit) {
        return <aside className="inspector">Edit not found</aside>;
      }
      return <PendingEditInspector edit={edit} />;
    }
    case "applied": {
      const rec = project.applied_edits.records.find(
        (r) => r.id === selection.id,
      );
      if (!rec) {
        return <aside className="inspector">Record not found</aside>;
      }
      return <AppliedEditInspector rec={rec} />;
    }
    case "track": {
      const track = project.tracks.find((t) => t.id === selection.trackId);
      if (!track) {
        return <aside className="inspector">Track not found</aside>;
      }
      return (
        <TrackInspector
          key={track.id}
          track={track}
          effects={project.effects_by_track[selection.trackId] ?? []}
        />
      );
    }
    case "chapter":
      return <ChapterInspector title={selection.id} time={selection.time} />;
    case "social": {
      const clip = (project.social_clips ?? []).find(
        (c) => c.id === selection.id,
      );
      if (!clip) {
        return <aside className="inspector">Social clip not found</aside>;
      }
      return <SocialClipInspector clip={clip} onSeek={setPlayheadSec} />;
    }
    case "comment": {
      const comment = (project.comments ?? []).find(
        (c) => c.id === selection.id,
      );
      if (!comment) {
        return <aside className="inspector">Comment not found</aside>;
      }
      if (comment.edit_decision_id) {
        const linked = project.pending_edits.find(
          (e) => e.id === comment.edit_decision_id,
        );
        if (linked) {
          return <PendingEditInspector edit={linked} />;
        }
      }
      return <CommentInspector comment={comment} onSeek={setPlayheadSec} />;
    }
    case "transcriptWord":
      return (
        <TranscriptWordInspector
          trackId={selection.trackId}
          wordIndex={selection.wordIndex}
        />
      );
    case "envelopePoint":
      return (
        <EnvelopePointInspector
          trackId={selection.trackId}
          index={selection.index}
        />
      );
    default:
      return null;
  }
}
