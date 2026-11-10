import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { ProjectView, Selection } from "../../types/project";
import { CommentThread } from "./CommentThread";

/**
 * What a comment selection opens: its thread, a "not found" note when the
 * comment is gone, or nothing when a pending edit holds the thread (the
 * Suggestion's Ask section shows it).
 */
export type CommentTarget = "thread" | "gone" | null;

export function commentTarget(
  selection: Selection,
  project: ProjectView | null,
): CommentTarget {
  if (selection?.kind !== "comment") return null;
  const comment = project?.comments?.find((c) => c.id === selection.id);
  if (!comment) return "gone";
  return comment.edit_decision_id &&
    project?.pending_edits.some((e) => e.id === comment.edit_decision_id)
    ? null
    : "thread";
}

export function useCommentSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const project = useDaw((s) =>
    selection?.kind === "comment" ? s.project : null,
  );
  const target = commentTarget(selection, project);
  if (!target || selection?.kind !== "comment") return null;
  return [
    {
      id: "comment",
      rows: [
        {
          id: "thread",
          control:
            target === "gone" ? (
              <p className="ui-field-hint">Comment not found</p>
            ) : (
              <CommentThread key={selection.id} commentId={selection.id} />
            ),
        },
      ],
    },
  ];
}
