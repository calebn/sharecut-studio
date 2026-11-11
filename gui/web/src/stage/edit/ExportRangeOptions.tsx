import { useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type BounceSource,
  bounceTracks,
  type ExportRangeChoices,
  type ExportScope,
  exportScopeOf,
  readExportRangeChoices,
  sourceFor,
  usableChoices,
  writeExportRangeChoices,
} from "../../edit/exportRange";
import { useDawStore } from "../../state/dawStore";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { ToggleButton } from "../../ui/ToggleButton";

const SOURCES: readonly { id: BounceSource; label: string }[] = [
  { id: "mix", label: "Full mix" },
  { id: "selected", label: "Selected tracks" },
  { id: "soloed", label: "Soloed" },
];

const MIX_NEEDS_NO_TRACKS = "Deselect the tracks to export the full mix.";

function reasonFor(
  source: BounceSource,
  scope: ExportScope,
  project: Parameters<typeof bounceTracks>[0],
  solo: Readonly<Record<string, boolean>>,
): string | undefined {
  if (source === "mix" && scope.intervals === null && scope.trackIds.length)
    return MIX_NEEDS_NO_TRACKS;
  const found = bounceTracks(project, scope, source, solo);
  return found.ok ? undefined : found.reason;
}

/**
 * The Export verb's options: which tracks the export mixes, and whether an MP3
 * comes with the WAV. A change is saved as it is made and applies to the next Export.
 */
export function ExportRangeOptions() {
  const { project, selection, solo } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      selection: s.selection,
      solo: s.soloTracks,
    })),
  );
  const [saved, setSaved] = useState<ExportRangeChoices>(
    readExportRangeChoices,
  );
  const noteId = useId();
  const scope = useMemo(() => {
    const found = project ? exportScopeOf(project, selection) : null;
    return found?.ok ? found.scope : null;
  }, [project, selection]);
  if (!project || !scope) return null;

  const choose = (next: ExportRangeChoices) => {
    setSaved(next);
    writeExportRangeChoices(next);
  };
  const shown = sourceFor(
    scope,
    usableChoices(project, scope, saved, solo).source,
  );
  const reasons = SOURCES.flatMap(({ id, label }) => {
    const reason = reasonFor(id, scope, project, solo);
    return reason ? [{ id, label, reason }] : [];
  });
  return (
    <>
      <SegmentedControl label="Source">
        {SOURCES.map(({ id, label }) => {
          const reason = reasons.find((r) => r.id === id)?.reason;
          return (
            <ToggleButton
              key={id}
              quiet
              pressed={shown === id}
              disabledReason={reason}
              aria-describedby={reason ? noteId : undefined}
              onClick={() => choose({ ...saved, source: id })}
            >
              {label}
            </ToggleButton>
          );
        })}
      </SegmentedControl>
      {reasons.length ? (
        <p id={noteId} className="export-dialog-note">
          {reasons.map((r) => `${r.label}: ${r.reason}`).join(" ")}
        </p>
      ) : null}
      <ToggleButton
        pressed={saved.includeMp3}
        onClick={() => choose({ ...saved, includeMp3: !saved.includeMp3 })}
      >
        Also MP3
      </ToggleButton>
    </>
  );
}
