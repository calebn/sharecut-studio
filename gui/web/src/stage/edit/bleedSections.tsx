import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  clipBleedDisabledReason,
  undoClipBleed,
} from "../../commands/clipBleed";
import { executePointerCommand } from "../../commands/pointer";
import {
  BLEED_ATTENUATION_LABELS,
  bleedAttenuationRegionKey,
  bleedAttenuationSpanLabel,
} from "../../edit/bleedAttenuation";
import {
  type ClipBleedRead,
  clipBleedSession,
} from "../../edit/clipBleedSession";
import { useClipPlacement } from "../../edit/clipPlacement";
import { rangeClips } from "../../edit/rangeSelection";
import { isGuestSession } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { Button, DefItem, DefinitionList, InlineError } from "../../ui";

const PLAN_LABELS = {
  disabled:
    "Automatic reduction is off. Saved speaker mutes are shown separately.",
  ready: "Current automatic reduction plan.",
  unavailable_evidence:
    "Automatic reduction could not be checked. Saved speaker mutes are shown separately.",
};
const ARTIFACT_LABELS = {
  missing:
    "No rendered audio yet. Saved choices will apply when audio is rendered.",
  stale:
    "Rendered audio is out of date. Saved choices are pending in the next render.",
  current: "Rendered audio is current.",
};
const RESTORE_LABELS = {
  none: "No Restore choice saved for this clip.",
  current: "Restore choice saved for this recording.",
  changed_content:
    "The recording changed. The previous Restore choice no longer applies. Refresh regions to inspect this recording.",
  unverified:
    "The saved Restore choice could not be checked. Refresh regions to check the recording.",
};
const CHECKING = "Checking automatic regions…";
const REFRESH_FIRST = "Refresh regions before restoring audio.";

const note = (text: string, role?: "status") => (
  <p className="sys-inspector-note" role={role}>
    {text}
  </p>
);
const section = (id: string, ...controls: ReactNode[]): InspectorSection => ({
  id,
  rows: controls
    .filter((control) => control != null)
    .map((control, i) => ({ id: `${id}${i}`, control })),
});

/**
 * The Inspector's content for the automatic reduction in one clip, over the
 * live clipBleedSession (#2294 W3b1b). The hook opens and retires the session
 * with the selection, as the host component it replaced did, so the Timeline
 * overlay and this sheet read the same inspection. The Restore choice still
 * goes through edit.restoreClipBleed; there is no Hear control yet.
 */
export function useBleedSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const state = useDaw((s) => ({
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    project: s.project,
    guestMode: s.guestMode,
    selection: s.selection,
    heldTrim: s.heldTrim,
    joinMutationInFlight: s.joinMutationInFlight,
    rangeBusy: s.rangeBusy,
    timelineDragging: s.timelineDragging,
  }));
  useClipPlacement();
  const snapshot = useSyncExternalStore(
    clipBleedSession.subscribe,
    clipBleedSession.getSnapshot,
  );
  const bleed = selection?.kind === "bleedAttenuation" ? selection : null;
  const trackId = bleed?.trackId ?? "";
  const clipId = bleed?.id ?? "";
  const found =
    bleed != null &&
    state.project != null &&
    rangeClips(state.project).some(
      (row) => row.id === clipId && row.track_id === trackId,
    );
  const clipLabel =
    state.project?.tracks.find((track) => track.id === trackId)?.label ??
    trackId;
  const host = !isGuestSession(state.projectPath, state.guestMode);
  const active =
    found &&
    snapshot?.occurrence.trackId === trackId &&
    snapshot.occurrence.clipId === clipId
      ? snapshot
      : null;
  const action = active?.action;
  const [elapsed, setElapsed] = useState<{
    action: typeof action;
    seconds: number;
  }>({ action: undefined, seconds: 0 });

  useEffect(() => {
    if (action?.state !== "saving" && action?.state !== "undoing") return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed({
        action,
        seconds: Math.floor((Date.now() - started) / 1000),
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [action]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new project or epoch reopens the same occurrence
  useEffect(() => {
    if (!found) return;
    if (host) void clipBleedSession.open({ trackId, clipId, clipLabel });
    else clipBleedSession.retire();
    return () => clipBleedSession.retire();
  }, [
    found,
    host,
    state.projectPath,
    state.projectEpoch,
    trackId,
    clipId,
    clipLabel,
  ]);

  useEffect(() => {
    const current = state.selection;
    if (
      !active ||
      active.action.state === "saving" ||
      active.action.state === "undoing" ||
      current?.kind !== "bleedAttenuation" ||
      current.id !== clipId ||
      current.trackId !== trackId
    )
      return;
    if (active.read.state === "ready") {
      if (
        active.selectedKey !== current.regionKey &&
        !clipBleedSession.select(current.regionKey) &&
        current.regionKey !== null
      )
        useDawStore.getState().setSelection({ ...current, regionKey: null });
    } else if (active.read.state === "error" && current.regionKey !== null) {
      useDawStore.getState().setSelection({ ...current, regionKey: null });
    }
  }, [active, state.selection, clipId, trackId]);

  if (!bleed) return null;
  if (!found)
    return [section("gone", <p className="ui-field-hint">Clip not found</p>)];

  const read: ClipBleedRead = host
    ? (active?.read ?? {
        state: "error",
        message: "Refresh regions to inspect this clip.",
      })
    : {
        state: "error",
        message: "Only the project host can inspect this audio.",
      };
  const selectedKey = active?.selectedKey ?? null;
  const inspection = read.state === "ready" ? read.inspection : undefined;
  const selected = inspection?.regions.find(
    (region) => bleedAttenuationRegionKey(region) === selectedKey,
  );
  const busy = action?.state === "saving" || action?.state === "undoing";
  const stale = action?.state === "error" && action.code === "STALE_TARGET";
  const busyLabel =
    action?.state === "saving"
      ? "Saving Restore choice…"
      : "Undoing Restore choice…";
  const permissionReason = clipBleedDisabledReason();
  const restoreReason = busy
    ? busyLabel
    : read.state === "loading"
      ? CHECKING
      : read.state === "error"
        ? REFRESH_FIRST
        : inspection?.regions.length === 0
          ? "There are no automatic regions to restore. Refresh regions to check again."
          : stale
            ? "This region changed. Refresh regions and select it again."
            : permissionReason !== undefined
              ? permissionReason
              : !selected
                ? "Select one automatic region below."
                : selected.restore.state === "unavailable"
                  ? selected.restore.reason
                  : selected.restore.state === "saved"
                    ? "A Restore choice already covers this interval."
                    : undefined;
  const seconds = elapsed.action === action ? elapsed.seconds : 0;

  const status = section(
    "status",
    ...(read.state === "loading" ? [note(CHECKING, "status")] : []),
    <InlineError
      message={read.state === "error" ? read.message : null}
      origin="state"
    />,
    <InlineError message={action?.state === "error" ? action.message : null} />,
    ...(busy
      ? [
          note(
            `${busyLabel}${seconds >= 2 ? ` ${seconds} s elapsed.` : ""}`,
            "status",
          ),
        ]
      : []),
  );
  const facts = inspection ? (
    <div className="inspector edit-sheet-part">
      <DefinitionList>
        <DefItem label="Clip">{inspection.clipLabel}</DefItem>
        <DefItem label="Automatic reduction">
          {PLAN_LABELS[inspection.planState]}
        </DefItem>
        {inspection.planReasons.length ? (
          <DefItem label="Why">{inspection.planReasons.join(" ")}</DefItem>
        ) : null}
        <DefItem label="Rendered audio">
          {ARTIFACT_LABELS[inspection.artifactState]}
        </DefItem>
        <DefItem label="Saved choice">
          {RESTORE_LABELS[inspection.restoreState]}
        </DefItem>
        {inspection.savedSourceSpans.length ? (
          <DefItem label="Saved source intervals">
            {inspection.savedSourceSpans
              .map(bleedAttenuationSpanLabel)
              .join(", ")}
          </DefItem>
        ) : null}
      </DefinitionList>
    </div>
  ) : null;
  const regions = inspection ? (
    inspection.regions.length ? (
      <div
        className="edit-bleed-regions"
        role="group"
        aria-label="Automatic regions in this clip"
      >
        {inspection.regions.map((region) => {
          const key = bleedAttenuationRegionKey(region);
          return (
            <Button
              key={key}
              aria-pressed={selectedKey === key}
              disabledReason={busy ? busyLabel : undefined}
              onClick={() => {
                const now = useDawStore.getState().selection;
                if (
                  now?.kind === "bleedAttenuation" &&
                  now.id === clipId &&
                  now.trackId === trackId &&
                  clipBleedSession.select(key)
                )
                  useDawStore
                    .getState()
                    .setSelection({ ...now, regionKey: key });
              }}
            >
              {BLEED_ATTENUATION_LABELS[region.kind]}{" "}
              <span>
                Timeline {bleedAttenuationSpanLabel(region.timelineSpan)}
              </span>{" "}
              <span>Source {bleedAttenuationSpanLabel(region.sourceSpan)}</span>
            </Button>
          );
        })}
      </div>
    ) : (
      note("No automatic regions in this clip. Refresh regions to check again.")
    )
  ) : null;
  const detail = selected ? (
    <div className="inspector edit-sheet-part">
      <DefinitionList>
        <DefItem label="Selected source interval">
          {bleedAttenuationSpanLabel(selected.sourceSpan)}
        </DefItem>
        {selected.restore.state === "available" ? (
          <DefItem label="Restore source interval">
            {bleedAttenuationSpanLabel(selected.restore.sourceSpan)}
          </DefItem>
        ) : null}
      </DefinitionList>
    </div>
  ) : null;

  const actions = host ? (
    <>
      <Button
        variant="primary"
        disabledReason={restoreReason}
        onClick={() => {
          const generation = active?.generation;
          void executePointerCommand("edit.restoreClipBleed").then((result) => {
            const current = clipBleedSession.getSnapshot();
            if (
              current?.generation === generation &&
              current?.occurrence.trackId === trackId &&
              current.occurrence.clipId === clipId &&
              result.status === "disabled" &&
              current.action.state !== "error"
            )
              useDawStore
                .getState()
                .announceStatus(result.reason, { tone: "error" });
          });
        }}
      >
        Restore original audio
      </Button>
      {restoreReason ? note(restoreReason) : null}
      <Button
        disabledReason={
          busy ? busyLabel : read.state === "loading" ? CHECKING : undefined
        }
        onClick={() => {
          const now = useDawStore.getState().selection;
          if (
            now?.kind === "bleedAttenuation" &&
            now.id === clipId &&
            now.trackId === trackId
          )
            useDawStore.getState().setSelection({ ...now, regionKey: null });
          if (active) void clipBleedSession.refresh();
          else void clipBleedSession.open({ trackId, clipId, clipLabel });
        }}
      >
        Refresh regions
      </Button>
      {active?.undo ? (
        <Button
          disabledReason={busy ? busyLabel : undefined}
          onClick={() => void undoClipBleed(active.undo!)}
        >
          Undo Restore
        </Button>
      ) : null}
    </>
  ) : (
    note("Only the project host can restore this audio.")
  );

  return [
    ...(status.rows.length > 0 ? [status] : []),
    ...(inspection
      ? [
          section("facts", facts),
          section("regions", regions, detail),
          section(
            "help",
            note(
              "Restore applies only to the selected source interval in this clip. Other copies keep their automatic reduction. Listen after the rendered audio is current.",
            ),
          ),
        ]
      : []),
    section("actions", <div className="edit-bleed-actions">{actions}</div>),
  ];
}
