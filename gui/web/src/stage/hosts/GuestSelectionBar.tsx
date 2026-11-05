import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { runRangeAction } from "../../commands/rangeActions";
import { canComment, rangeEditMode } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { ActionBar, type BarItem } from "../../system/ActionBar";
import type { BarId } from "../../system/editActionSets";
import { useSelectionAnchor } from "../edit/useSelectionAnchor";

/**
 * The floating Action bar over a guest's word selection in Review: Comment
 * and Suggest a cut, nothing else. A Viewer gets no bar; a link that may not
 * suggest gets Comment alone; an Editor's cut applies, so it reads Cut.
 */
export function GuestSelectionBar({ root }: { root: HTMLElement | null }) {
  const { selection, projectPath, shareCapabilities, guestMode } = useDawStore(
    useShallow((s) => ({
      selection: s.selection,
      projectPath: s.projectPath,
      shareCapabilities: s.shareCapabilities,
      guestMode: s.guestMode,
    })),
  );
  const mode = rangeEditMode(projectPath, shareCapabilities);
  const mayComment = canComment(projectPath, guestMode, shareCapabilities);
  const anchor = useSelectionAnchor(
    root,
    selection,
    selection?.kind === "transcriptRange",
  );
  const onVerb = useCallback((id: BarId) => {
    const action = id === "cut" ? "cut" : id === "comment" ? "comment" : null;
    if (!action) return;
    void runRangeAction(action).then((result) => {
      if (result.status === "disabled")
        useDawStore.getState().announceStatus(result.reason, { tone: "error" });
    });
  }, []);
  if (selection?.kind !== "transcriptRange" || !anchor.visible) return null;
  const items: BarItem[] = mayComment ? [{ id: "comment" }] : [];
  const primary =
    mode === "none"
      ? undefined
      : {
          id: "cut" as const,
          label: mode === "suggest" ? "Suggest a cut" : "Cut",
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
