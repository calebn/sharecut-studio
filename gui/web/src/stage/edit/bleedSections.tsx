import type { ReactNode } from "react";
import { undoClipBleed } from "../../commands/clipBleed";
import {
  BLEED_ATTENUATION_LABELS,
  type BleedAttenuationInspection,
  bleedAttenuationRegionKey,
  bleedAttenuationSpanLabel,
} from "../../edit/bleedAttenuation";
import { bleedBusyLabel, CHECKING } from "../../edit/bleedRestoreReason";
import {
  type ClipBleedRead,
  clipBleedSession,
} from "../../edit/clipBleedSession";
import { useDawStore } from "../../state/dawStore";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { Button, InlineError } from "../../ui";
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
type InspectorRow = InspectorSection["rows"][number];

const spanRow = (
  id: string,
  label: string,
  span: Parameters<typeof bleedAttenuationSpanLabel>[0],
): InspectorRow => ({
  id,
  label,
  control: <span>{bleedAttenuationSpanLabel(span)}</span>,
});

const factRows = (inspection: Inspection): InspectorRow[] => [
  { id: "clip", label: "Clip", control: <span>{inspection.clipLabel}</span> },
  {
    id: "plan",
    label: "Reduction",
    control: note(PLAN_LABELS[inspection.planState]),
  },
  ...(inspection.planReasons.length
    ? [
        {
          id: "why",
          label: "Why",
          control: note(inspection.planReasons.join(" ")),
        },
      ]
    : []),
  {
    id: "artifact",
    label: "Audio",
    control: note(ARTIFACT_LABELS[inspection.artifactState]),
  },
  {
    id: "restore",
    label: "Saved choice",
    control: note(RESTORE_LABELS[inspection.restoreState]),
  },
  ...(inspection.savedSourceSpans.length
    ? [
        {
          id: "saved",
          label: "Saved restores",
          control: (
            <span>
              {inspection.savedSourceSpans
                .map(bleedAttenuationSpanLabel)
                .join(", ")}
            </span>
          ),
        },
      ]
    : []),
];

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
  const busyLabel = bleedBusyLabel(action);
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
      { id: "facts", rows: factRows(inspection) },
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
      ),
      ...(selected
        ? [
            {
              id: "detail",
              rows: [
                spanRow("selected", "Selected range", selected.sourceSpan),
                ...(selected.restore.state === "available"
                  ? [
                      spanRow(
                        "restores",
                        "Restores",
                        selected.restore.sourceSpan,
                      ),
                    ]
                  : []),
              ],
            },
          ]
        : []),
      section(
        "help",
        note(
          "Keep restores the original audio for the selected range in this clip only. Other copies keep their automatic reduction. Listen after the rendered audio is current.",
        ),
      ),
    );
  }
  sections.push(
    section("actions", <div className="edit-bleed-actions">{actions}</div>),
  );
  return sections;
}
