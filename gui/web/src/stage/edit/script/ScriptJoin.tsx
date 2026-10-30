import { useShallow } from "zustand/react/shallow";
import { useDawStore } from "../../../state/dawStore";
import { EditBoundaryMark } from "../../../transcript/EditBoundaryMark";

/**
 * The join's own controls (roll, trim, precision) beside the cut where the
 * Script shows it. They stay here until the Seam inspector takes them.
 */
export function ScriptJoin({ id }: { id: string }) {
  const { boundary, left, right } = useDawStore(
    useShallow((s) => {
      const found = s.project?.edit_boundaries?.find((b) => b.id === id);
      const clips = found
        ? (s.project?.clips.tracks[found.track_id] ?? [])
        : [];
      return {
        boundary: found,
        left: clips.find((c) => c.id === found?.left_clip_id) ?? null,
        right: found?.right_clip_id
          ? (clips.find((c) => c.id === found.right_clip_id) ?? null)
          : null,
      };
    }),
  );
  if (!boundary) return null;
  return (
    <EditBoundaryMark boundary={boundary} leftClip={left} rightClip={right} />
  );
}
