import {
  BLEED_ATTENUATION_LABELS,
  type BleedAttenuationInspection,
  bleedAttenuationRegionKey,
  bleedAttenuationSpanLabel,
} from "../../edit/bleedAttenuation";
import { Button } from "../../ui/Button";
import { DefItem, DefinitionList } from "../../ui/DefinitionList";
import { InlineError } from "../../ui/InlineError";
import { ModifierInspector } from "../ModifierInspector";
import "./BleedAttenuationInspector.css";

type InspectionState<TTarget> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; inspection: BleedAttenuationInspection<TTarget> };

type ActionState =
  | { state: "idle" }
  | { state: "saving" | "undoing"; elapsedSeconds?: number }
  | { state: "error"; code: "STALE_TARGET" | "failed"; message: string };

export type BleedAttenuationInspectorProps<TTarget, TUndo = never> = {
  read: InspectionState<TTarget>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  access: "host" | "guest";
  canRestore: boolean;
  permissionReason?: string;
  action: ActionState;
  onRestore: (target: TTarget) => void;
  onRefresh: () => void;
  undo?: {
    receipt: TUndo;
    onUndo: (receipt: TUndo) => void;
    disabledReason?: string;
  };
};

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

export function BleedAttenuationInspector<TTarget, TUndo = never>({
  read,
  selectedKey,
  onSelect,
  access,
  canRestore,
  permissionReason,
  action,
  onRestore,
  onRefresh,
  undo,
}: BleedAttenuationInspectorProps<TTarget, TUndo>) {
  const inspection = read.state === "ready" ? read.inspection : undefined;
  const selected = inspection?.regions.find(
    (region) => bleedAttenuationRegionKey(region) === selectedKey,
  );
  const busy = action.state === "saving" || action.state === "undoing";
  const stale = action.state === "error" && action.code === "STALE_TARGET";
  const busyLabel =
    action.state === "saving"
      ? "Saving Restore choice…"
      : "Undoing Restore choice…";
  const restoreReason = busy
    ? busyLabel
    : read.state === "loading"
      ? "Checking automatic regions…"
      : read.state === "error"
        ? "Refresh regions before restoring audio."
        : inspection?.regions.length === 0
          ? "There are no automatic regions to restore. Refresh regions to check again."
          : stale
            ? "This region changed. Refresh regions and select it again."
            : !canRestore
              ? (permissionReason ??
                "Restore is unavailable with your current access.")
              : !selected
                ? "Select one automatic region below."
                : selected.restore.state === "unavailable"
                  ? selected.restore.reason
                  : selected.restore.state === "saved"
                    ? "A Restore choice already covers this interval."
                    : undefined;
  const refreshReason = busy
    ? busyLabel
    : read.state === "loading"
      ? "Checking automatic regions…"
      : undefined;

  return (
    <ModifierInspector
      badge="Audio"
      title="Automatic reduction"
      subtitle={inspection?.clipLabel}
      footer={
        <div className="bleed-inspector-actions">
          {access === "host" ? (
            <>
              <Button
                variant="primary"
                disabledReason={
                  restoreReason ??
                  (read.state !== "ready"
                    ? "Refresh regions before restoring audio."
                    : undefined)
                }
                onClick={() => {
                  if (
                    !restoreReason &&
                    selected?.restore.state === "available"
                  ) {
                    onRestore(selected.restore.target);
                  }
                }}
              >
                Restore original audio
              </Button>
              {restoreReason ? (
                <p className="modifier-note">{restoreReason}</p>
              ) : null}
              <Button disabledReason={refreshReason} onClick={onRefresh}>
                Refresh regions
              </Button>
              {undo ? (
                <Button
                  disabledReason={busy ? busyLabel : undo.disabledReason}
                  onClick={() => undo.onUndo(undo.receipt)}
                >
                  Undo Restore
                </Button>
              ) : null}
            </>
          ) : (
            <p className="modifier-note">
              Only the project host can restore this audio.
            </p>
          )}
        </div>
      }
    >
      {read.state === "loading" ? (
        <p role="status">Checking automatic regions…</p>
      ) : null}
      <InlineError
        message={read.state === "error" ? read.message : null}
        origin="state"
      />
      <InlineError message={action.state === "error" ? action.message : null} />
      {busy ? (
        <p role="status">
          {busyLabel}
          {(action.elapsedSeconds ?? 0) >= 2
            ? ` ${action.elapsedSeconds} s elapsed.`
            : ""}
        </p>
      ) : null}
      {inspection ? (
        <>
          <DefinitionList>
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
          {inspection.regions.length ? (
            <div
              className="bleed-region-list"
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
                    onClick={() => onSelect(key)}
                  >
                    {BLEED_ATTENUATION_LABELS[region.kind]}{" "}
                    <span>
                      Timeline {bleedAttenuationSpanLabel(region.timelineSpan)}
                    </span>{" "}
                    <span>
                      Source {bleedAttenuationSpanLabel(region.sourceSpan)}
                    </span>
                  </Button>
                );
              })}
            </div>
          ) : (
            <p>
              No automatic regions in this clip. Refresh regions to check again.
            </p>
          )}
          {selected ? (
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
          ) : null}
          <p className="modifier-note">
            Restore applies only to the selected source interval in this clip.
            Other copies keep their automatic reduction. Listen after the
            rendered audio is current.
          </p>
        </>
      ) : null}
    </ModifierInspector>
  );
}
