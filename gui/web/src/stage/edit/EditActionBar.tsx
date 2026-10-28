import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { barModelOf, editFactsOf, runEditVerb } from "../../commands/editVerbs";
import { makeRangeTarget } from "../../edit/rangeSelection";
import { useDawStore } from "../../state/dawStore";
import { ActionBar, SelectionCount } from "../../system/ActionBar";
import type { BarId } from "../../system/editActionSets";
import { ScopeChip } from "../../system/ScopeChip";
import { dialogueTrackIds } from "../../utils/bladeTracks";
import { scopeOf } from "./barScope";
import { useSelectionAnchor } from "./useSelectionAnchor";

type EditActionBarForm = "floating" | "dock";

function toggleRangeScope(narrow: { current: readonly string[] | null }) {
  const s = useDawStore.getState();
  const selection = s.selection;
  if (selection?.kind !== "range" || !s.project) return;
  const held = selection.target.track_ids;
  const everyone = dialogueTrackIds(s.project.tracks);
  const wide = everyone.every((id) => held.includes(id));
  const next = wide ? (narrow.current ?? held.slice(0, 1)) : everyone;
  if (!wide) narrow.current = held;
  const target = makeRangeTarget(s.project, selection.target.intervals, [
    ...next,
  ]);
  if (target) s.setSelection({ kind: "range", target });
  else
    s.announceStatus("No audio on those tracks in this range", {
      tone: "error",
    });
}

function EditActionBarImpl({
  form,
  root,
}: {
  form: EditActionBarForm;
  root: HTMLElement | null;
}) {
  const { selection, project, projectPath, shareCapabilities, moreRequest } =
    useDawStore(
      useShallow((s) => ({
        selection: s.selection,
        project: s.project,
        projectPath: s.projectPath,
        shareCapabilities: s.shareCapabilities,
        moreRequest: s.moreRequest,
      })),
    );
  const gates = useDawStore(
    useShallow((s) => ({
      guestMode: s.guestMode,
      rangeBusy: s.rangeBusy,
      joinMutationInFlight: s.joinMutationInFlight,
      transcriptCorrecting: s.transcriptCorrecting,
      sessionRegion: s.sessionRegion,
    })),
  );
  const floating = form === "floating";
  const facts = useMemo(
    () => editFactsOf({ selection, project, projectPath, shareCapabilities }),
    [selection, project, projectPath, shareCapabilities],
  );
  const model = useMemo(
    () =>
      facts ? barModelOf(facts, { ...useDawStore.getState(), ...gates }) : null,
    [facts, gates],
  );
  const anchor = useSelectionAnchor(
    root,
    selection,
    floating && facts !== null && facts.kind !== "playhead",
  );
  const narrow = useRef<readonly string[] | null>(null);
  const factsRef = useRef(facts);
  useEffect(() => {
    factsRef.current = facts;
  }, [facts]);
  const onVerb = useCallback((id: BarId, arg?: string) => {
    const live = factsRef.current;
    if (live) void runEditVerb(id, live, arg);
  }, []);

  if (!facts || !model || !project) return null;
  if (floating && !anchor.visible) return null;
  if (!model.items.length && !model.primary) return null;

  const scope = scopeOf(facts, project);
  const leading =
    model.leading === "scope" ? (
      <ScopeChip
        tracks={scope.tracks}
        all={scope.all}
        ripple={scope.all}
        onToggle={
          facts.role !== "readOnly" && facts.kind === "range"
            ? () => toggleRangeScope(narrow)
            : undefined
        }
      />
    ) : model.leading === "count" ? (
      <SelectionCount count={facts.count} />
    ) : undefined;

  return (
    <ActionBar
      placement={
        floating
          ? {
              form: "floating",
              anchorRef: anchor.ref,
              moves: anchor.moves,
              // below, so the ruler above the first lane stays uncovered
              prefer: "below",
            }
          : { form: "dock" }
      }
      ariaLabel={floating ? "Selection actions" : "Edit actions"}
      leading={leading}
      items={model.items}
      more={model.more}
      primary={model.primary ?? undefined}
      moreRequest={moreRequest}
      onVerb={onVerb}
    />
  );
}

export const EditActionBar = memo(EditActionBarImpl);
