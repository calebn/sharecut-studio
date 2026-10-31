import type { ReactNode } from "react";
import {
  clipBleedDisabledReason,
  undoClipBleed,
} from "../../commands/clipBleed";
import { executePointerCommand } from "../../commands/pointer";
import {
  BLEED_ATTENUATION_LABELS,
  type BleedAttenuationInspection,
  bleedAttenuationRegionKey,
  bleedAttenuationSpanLabel,
} from "../../edit/bleedAttenuation";
import {
  type ClipBleedRead,
  clipBleedSession,
} from "../../edit/clipBleedSession";
import { useDawStore } from "../../state/dawStore";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { Button, DefItem, DefinitionList, InlineError } from "../../ui";
import { bleedRestoreReason, CHECKING } from "./bleedRestoreReason";
import { note } from "./sheetNote";
import { useBleedSession } from "./useBleedSession";

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

const section = (id: string, ...controls: ReactNode[]): InspectorSection => ({
  id,
  rows: controls.map((control, i) => ({ id: `${id}${i}`, control })),
});

type Inspection = BleedAttenuationInspection<unknown>;

const spanRow = (
  label: string,
  span: Parameters<typeof bleedAttenuationSpanLabel>[0],
) => <DefItem label={label}>{bleedAttenuationSpanLabel(span)}</DefItem>;

const facts = (inspection: Inspection) => {
  return (
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
  );
};

export function useBleedSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const bleed = selection?.kind === "bleedAttenuation" ? selection : null;
  const session = useBleedSession(bleed);
  if (!bleed) return null;
  const { found, host, active, clipLabel, trackId, clipId, isThisClip } =
    session;
  if (!found)
    return [section("gone", <p className="ui-field-hint">Clip not found</p>)];

  const action = active?.action;
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
  const busyLabel = busy
    ? action.state === "saving"
      ? "Saving Restore choice…"
      : "Undoing Restore choice…"
    : null;
  const restoreReason = bleedRestoreReason({
    busyLabel,
    read,
    stale: action?.state === "error" && action.code === "STALE_TARGET",
    permissionReason: clipBleedDisabledReason(),
    selected,
  });
  const seconds = session.elapsedSeconds;
  const undo = active?.undo;

  const statusRows: ReactNode[] = [];
  if (read.state === "loading") statusRows.push(note(CHECKING, "status"));
  if (read.state === "error")
    statusRows.push(<InlineError message={read.message} origin="state" />);
  if (action?.state === "error")
    statusRows.push(<InlineError message={action.message} />);
  if (busyLabel)
    statusRows.push(
      note(
        `${busyLabel}${seconds >= 2 ? ` ${seconds} s elapsed.` : ""}`,
        "status",
      ),
    );

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
          busyLabel ?? (read.state === "loading" ? CHECKING : undefined)
        }
        onClick={() => {
          const now = useDawStore.getState().selection;
          if (isThisClip(now))
            useDawStore.getState().setSelection({ ...now, regionKey: null });
          if (active) void clipBleedSession.refresh();
          else void clipBleedSession.open({ trackId, clipId, clipLabel });
        }}
      >
        Refresh regions
      </Button>
      {undo ? (
        <Button
          disabledReason={busyLabel ?? undefined}
          onClick={() => void undoClipBleed(undo)}
        >
          Undo Restore
        </Button>
      ) : null}
    </>
  ) : (
    note("Only the project host can restore this audio.")
  );

  const sections: InspectorSection[] = [];
  if (statusRows.length) sections.push(section("status", ...statusRows));
  if (inspection) {
    sections.push(
      section("facts", facts(inspection)),
      section(
        "regions",
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
                  disabledReason={busyLabel ?? undefined}
                  onClick={() => {
                    const now = useDawStore.getState().selection;
                    if (isThisClip(now) && clipBleedSession.select(key))
                      useDawStore
                        .getState()
                        .setSelection({ ...now, regionKey: key });
                  }}
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
          note(
            "No automatic regions in this clip. Refresh regions to check again.",
          )
        ),
        ...(selected
          ? [
              <div key="detail" className="inspector edit-sheet-part">
                <DefinitionList>
                  {spanRow("Selected source interval", selected.sourceSpan)}
                  {selected.restore.state === "available"
                    ? spanRow(
                        "Restore source interval",
                        selected.restore.sourceSpan,
                      )
                    : null}
                </DefinitionList>
              </div>,
            ]
          : []),
      ),
      section(
        "help",
        note(
          "Restore applies only to the selected source interval in this clip. Other copies keep their automatic reduction. Listen after the rendered audio is current.",
        ),
      ),
    );
  }
  sections.push(
    section("actions", <div className="edit-bleed-actions">{actions}</div>),
  );
  return sections;
}
