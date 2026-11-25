import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  EXPORT_CANCELLING_REASON,
  EXPORT_STARTING_REASON,
} from "../../commands/bounceRunnerHandle";
import { barModelOf, editFactsOf, runEditVerb } from "../../commands/editVerbs";
import { makeRangeTarget } from "../../edit/rangeSelection";
import { useDawStore } from "../../state/dawStore";
import {
  ActionBar,
  SelectionCount,
  SelectionObject,
} from "../../system/ActionBar";
import type { BarId } from "../../system/editActionSets";
import { ScopeChip } from "../../system/ScopeChip";
import { SystemIcon } from "../../system/SystemIcon";
import type { Selection } from "../../types/project";
import { CloseButton } from "../../ui/CloseButton";
import { CommandButton } from "../../ui/CommandButton";
import { dialogueTrackIds } from "../../utils/bladeTracks";
import { selectionAnchor } from "../../utils/timelineReveal";
import { useBounceRun } from "../hosts/bounceRunnerContext";
import { scopeOf } from "./barScope";
import { ExportRangeOptions } from "./ExportRangeOptions";
import { inspectorHeading, inspectorShortName } from "./inspectorHeading";
import { useSelectionAnchor } from "./useSelectionAnchor";

const EXPORT_OPTIONS = "Export options";

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

function focusOwnerOf(
  selection: Selection,
  root: HTMLElement | null,
): HTMLElement | null {
  const scope: ParentNode = root ?? document;
  if (selection?.kind === "clip")
    return scope.querySelector<HTMLElement>(
      `[data-clip-id="${CSS.escape(selection.id)}"] .clip-hit`,
    );
  if (selection?.kind === "seam")
    return scope.querySelector<HTMLElement>(
      `[data-lane-seam-id="${CSS.escape(selection.id)}"] .sys-seam-hit`,
    );
  return null;
}

function ClearButton({
  floating,
  selection,
  root,
  onCleared,
}: {
  floating: boolean;
  selection: Selection;
  root: HTMLElement | null;
  onCleared?: () => void;
}) {
  const keepFocus = () => {
    onCleared?.();
    const owner = focusOwnerOf(selection, root);
    queueMicrotask(() => {
      const target = owner?.isConnected ? owner : root;
      if (!target?.isConnected) return;
      if (target === root && !target.hasAttribute("tabindex"))
        target.tabIndex = -1;
      target.focus({ preventScroll: true });
    });
  };
  return (
    <CommandButton
      commandId="edit.clearSelection"
      args={{ from: "bar" }}
      bare
      className={
        floating ? "sys-icon-btn sys-actions-icon" : "sys-actions-dock-btn"
      }
      aria-label="Clear selection"
      title="Clear selection"
      onClick={keepFocus}
    >
      <SystemIcon name="x" size={floating ? 16 : 20} />
      {floating ? null : <span className="sys-actions-dock-label">Clear</span>}
    </CommandButton>
  );
}

/**
 * Brings the selection's anchor back into the timeline. The floating bar shows
 * it only while pinned; the dock, which has no pin state, always does.
 */
function RevealButton({
  floating,
  label,
}: {
  floating: boolean;
  label: "Show edit" | "Show selection";
}) {
  // The bar drops this button the moment the anchor is back in view, with
  // focus on it; focus goes to the next control, never to the page.
  useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      if (!active?.hasAttribute("data-reveal-selection")) return;
      active
        .closest(".sys-actions")
        ?.querySelector<HTMLElement>(
          '[aria-label="Clear selection"], [data-inspector-close]',
        )
        ?.focus({ preventScroll: true });
    },
    [],
  );
  return (
    <CommandButton
      commandId="view.revealSelection"
      bare
      className={
        floating ? "sys-icon-btn sys-actions-reveal" : "sys-actions-dock-btn"
      }
      aria-label={label}
      data-reveal-selection=""
    >
      <SystemIcon name="locate" size={floating ? 16 : 20} />
      {floating ? (
        <span>{label}</span>
      ) : (
        <span className="sys-actions-dock-label">{label}</span>
      )}
    </CommandButton>
  );
}

function EditActionBarImpl({
  form,
  root,
  onRan,
  inInspector = false,
  clear = false,
  onCleared,
  onClose,
}: {
  form: EditActionBarForm;
  root: HTMLElement | null;
  onRan?: (id: BarId) => void;
  /** The dock of the open Inspector sheet, whose own grip stands for Inspect. */
  inInspector?: boolean;
  clear?: boolean;
  onCleared?: () => void;
  onClose?: () => void;
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
      pendingDecisionInFlight: s.pendingDecisionInFlight,
      pendingRetimeInFlight: s.pendingRetimeInFlight,
      sessionRegion: s.sessionRegion,
      activityJob: s.activityJob,
    })),
  );
  const floating = form === "floating";
  const facts = useMemo(
    () => editFactsOf({ selection, project, projectPath, shareCapabilities }),
    [selection, project, projectPath, shareCapabilities],
  );
  const run = useBounceRun();
  const exporting = run.kind === "running";
  const cancelReason =
    run.kind !== "running"
      ? null
      : run.jobId === null
        ? EXPORT_STARTING_REASON
        : run.cancelling
          ? EXPORT_CANCELLING_REASON
          : null;
  const model = useMemo(
    () =>
      facts
        ? barModelOf(
            facts,
            { ...useDawStore.getState(), ...gates },
            exporting,
            cancelReason,
          )
        : null,
    [facts, gates, exporting, cancelReason],
  );
  const items = useMemo(
    () =>
      model?.items.map((item) =>
        item.id === "export"
          ? {
              ...item,
              split: { label: EXPORT_OPTIONS, content: <ExportRangeOptions /> },
            }
          : item,
      ),
    [model],
  );
  // The phone dock has no root of its own: it finds its anchor in the page.
  const anchor = useSelectionAnchor(
    root ?? (floating ? null : document.body),
    selection,
    facts !== null && facts.kind !== "playhead",
  );
  useEffect(() => {
    selectionAnchor.set(anchor.ref);
    return () => selectionAnchor.release(anchor.ref);
  }, [anchor.ref]);
  const { pinned } = anchor;
  const revealLabel =
    selection?.kind === "pending" ? "Show edit" : "Show selection";
  const wasPinned = useRef<boolean | null>(null);
  const announceLabel = useRef(revealLabel);
  announceLabel.current = revealLabel;
  useEffect(() => {
    const was = wasPinned.current;
    wasPinned.current = pinned;
    if (floating && was === false && pinned)
      useDawStore
        .getState()
        .announceStatus(`${announceLabel.current} to return to it`);
  }, [pinned, floating]);
  const narrow = useRef<readonly string[] | null>(null);
  const factsRef = useRef(facts);
  useEffect(() => {
    factsRef.current = facts;
  }, [facts]);
  const onVerb = useCallback(
    (id: BarId, arg?: string) => {
      const live = factsRef.current;
      if (live) void runEditVerb(id, live, arg);
      onRan?.(id);
    },
    [onRan],
  );

  if (!facts || !model || !project) return null;
  if (floating && !anchor.present) return null;
  if (!model.items.length && !model.primary) return null;

  const scope = scopeOf(facts, project);
  const kindLeading =
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
  const leading =
    !floating && selection ? (
      <>
        <SelectionObject
          icon={inspectorHeading(selection, project).icon}
          name={inspectorShortName(selection, project)}
        />
        {model.leading === "count" ? null : kindLeading}
      </>
    ) : (
      kindLeading
    );

  const end = inInspector ? (
    onClose ? (
      <CloseButton
        className="sys-actions-dock-btn"
        data-inspector-close=""
        onClick={onClose}
      />
    ) : undefined
  ) : clear && selection ? (
    <ClearButton
      floating={floating}
      selection={selection}
      root={root}
      onCleared={onCleared}
    />
  ) : undefined;
  // On the dock it rides in Clear's or Close's slot, so it never costs a verb its place.
  const reveal =
    (floating ? pinned : anchor.present && end !== undefined) && selection ? (
      <RevealButton floating={floating} label={revealLabel} />
    ) : null;
  const trailing =
    reveal || end ? (
      <>
        {reveal}
        {end}
      </>
    ) : undefined;

  return (
    <ActionBar
      placement={
        floating
          ? {
              form: "floating",
              anchorRef: anchor.ref,
              exclusion: anchor.exclusion,
              moves: anchor.moves,
              clearTop: anchor.clearTop,
              rect: anchor.rect,
              pinned,
            }
          : { form: "dock" }
      }
      ariaLabel={floating ? "Selection actions" : "Edit actions"}
      leading={leading}
      items={
        inInspector
          ? (items ?? []).filter((item) => item.id !== "inspect")
          : (items ?? [])
      }
      more={model.more}
      primary={model.primary ?? undefined}
      trailing={trailing}
      leadingSlots={model.leading === "scope" ? 1 : 0}
      reserveEnd={inInspector}
      moreRequest={moreRequest}
      onVerb={onVerb}
    />
  );
}

export const EditActionBar = memo(EditActionBarImpl);
