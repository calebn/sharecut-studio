import { type Seam, seamTitle } from "../../edit/seam";
import { canHostMutate } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { appliedEditTitle } from "../../timeline/appliedEditTicks";
import type { Selection } from "../../types/project";
import { InlineError } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { relativeTime } from "../../utils/relativeTime";
import { SeamAbRow } from "./SeamAbRow";
import {
  joinLengthRows,
  joinOffsetRows,
  useSeamJoinFields,
} from "./seamJoinFields";
import { note } from "./sheetNote";
import { AB_CLAMPED_REASON, useSeamAudition } from "./useSeamAudition";

const AB_GUEST_REASON = "A/B needs the host app";
const AB_UNROLLED_REASON = "Roll the seam to compare";
const AB_BUSY_REASON = "A/B is ready once the roll saves";
const ROLLED_EPS_SEC = 1e-9;

function appliedByLine(seam: Extract<Seam, { kind: "cut" }>): string | null {
  const first = seam.records[0];
  if (!first) return null;
  const more = seam.records.length - 1;
  const age = relativeTime(first.applied_at, new Date());
  return `${appliedEditTitle(first)} · applied ${age}${more > 0 ? ` · +${more} more` : ""}`;
}

export function useSeamSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const projectPath = useDaw((s) => s.projectPath);
  const seamId = selection?.kind === "seam" ? selection.id : null;
  const fields = useSeamJoinFields(seamId);
  const seam = fields?.seam ?? null;
  const audition = useSeamAudition(seam, fields?.originEnd ?? null);

  if (selection?.kind !== "seam") return null;
  if (!seam || !fields) {
    return [
      { id: "gone", rows: [{ id: "gone", control: note("Seam not found") }] },
    ];
  }

  const { busy, editable, interval, error, sinceOpenSec } = fields;
  const appliedBy = seam.kind === "cut" ? appliedByLine(seam) : null;
  const abReason = !canHostMutate(projectPath)
    ? AB_GUEST_REASON
    : Math.abs(sinceOpenSec) <= ROLLED_EPS_SEC
      ? AB_UNROLLED_REASON
      : audition.error === AB_CLAMPED_REASON
        ? AB_CLAMPED_REASON
        : busy
          ? AB_BUSY_REASON
          : null;
  const auditionFailure =
    audition.error === AB_CLAMPED_REASON ? null : audition.error;

  return [
    {
      id: "seam",
      rows: [
        { id: "title", control: note(seamTitle(seam), "status") },
        ...(appliedBy ? [{ id: "appliedBy", control: note(appliedBy) }] : []),
        ...joinLengthRows(fields),
        ...joinOffsetRows(fields),
        ...(interval
          ? [
              {
                id: "ab",
                label: "A/B",
                control: (
                  <SeamAbRow
                    reason={abReason}
                    side={audition.side}
                    pending={audition.pending}
                    joinSec={seam.joinSec}
                    onSelect={(next) => {
                      fields.supersede();
                      audition.play(next);
                    }}
                  />
                ),
              },
            ]
          : []),
        ...(editable && busy
          ? [{ id: "busy", control: note(BUSY_REASON, "status") }]
          : []),
        ...((error ?? auditionFailure)
          ? [
              {
                id: "error",
                control: (
                  <InlineError message={error ?? auditionFailure ?? ""} />
                ),
              },
            ]
          : []),
      ],
    },
  ];
}
