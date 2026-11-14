import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { runRangeAction } from "../../commands/rangeActions";
import { runAndAnnounceRefusal } from "../../commands/refusal";
import {
  resolveSelectionRange,
  TRANSCRIPT_REFRESHING,
} from "../../edit/rangeSelection";
import { canComment, rangeEditMode } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { ActionBar, type BarItem } from "../../system/ActionBar";
import type { BarId } from "../../system/editActionSets";
import { useSelectionAnchor } from "../edit/useSelectionAnchor";

/**
 * The floating Action bar over a guest's word selection in Review: Comment
 * and Suggest a cut, nothing else. A Viewer gets no bar (the host mounts this
 * only when the link may select a range). A link that may not suggest gets
 * Comment alone, a branch reachable only when `mayRange` holds; an Editor's cut
 * applies, so it reads Cut.
 */
export function GuestSelectionBar({
  root,
  phone = false,
}: {
  root: HTMLElement | null;
  /** The phone layout: the transcript block is short, so the bar may use the page. */
  phone?: boolean;
}) {
  const { selection, projectPath, shareCapabilities, guestMode } = useDawStore(
    useShallow((s) => ({
      selection: s.selection,
      projectPath: s.projectPath,
      shareCapabilities: s.shareCapabilities,
      guestMode: s.guestMode,
    })),
  );
  const refreshing = useDawStore((s) =>
    s.project?.meta?.hydration?.transcript_words === false &&
    s.selection?.kind === "transcriptRange"
      ? resolveSelectionRange(s.project, s.selection).refreshing
        ? TRANSCRIPT_REFRESHING
        : undefined
      : undefined,
  );
  const mode = rangeEditMode(projectPath, shareCapabilities);
  const mayComment = canComment(projectPath, guestMode, shareCapabilities);
  const anchor = useSelectionAnchor(
    root,
    selection,
    selection?.kind === "transcriptRange",
    // On a phone the transcript block is short: the bar may hang below a
    // selection near its end, and stays clamped inside the viewport.
    phone ? (root?.ownerDocument.documentElement ?? null) : root,
  );
  const onVerb = useCallback((id: BarId) => {
    const action = id === "cut" ? "cut" : id === "comment" ? "comment" : null;
    if (!action) return;
    void runAndAnnounceRefusal(() => runRangeAction(action));
  }, []);
  if (selection?.kind !== "transcriptRange" || !anchor.visible) return null;
  const items: BarItem[] = mayComment
    ? [{ id: "comment", disabledReason: refreshing }]
    : [];
  const primary =
    mode === "none"
      ? undefined
      : {
          id: "cut" as const,
          label: mode === "suggest" ? "Suggest a cut" : "Cut",
          disabledReason: refreshing,
        };
  if (!items.length && !primary) return null;
  return (
    <ActionBar
      placement={{
        form: "floating",
        anchorRef: anchor.ref,
        exclusion: anchor.exclusion,
        moves: anchor.moves,
        prefer: "above",
      }}
      ariaLabel="Selection actions"
      items={items}
      primary={primary}
      onVerb={onVerb}
    />
  );
}
