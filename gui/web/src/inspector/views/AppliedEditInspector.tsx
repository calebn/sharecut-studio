import { restoreAppliedEdit } from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { canApplyPass12 } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { AppliedEditRecord } from "../../types/project";
import { DefItem, DefinitionList, InspectorSeekFooter } from "../../ui";
import { ModifierInspector } from "../ModifierInspector";

export function AppliedEditInspector({ rec }: { rec: AppliedEditRecord }) {
  const { projectPath, guestMode, shareCapabilities, setSelection } = useDaw();
  const { busy, error, run } = useProjectMutation();

  const canRestore =
    canApplyPass12(projectPath, guestMode, shareCapabilities) &&
    rec.source_start != null &&
    rec.source_end != null &&
    rec.timeline_start != null &&
    rec.timeline_end != null;

  const onRestore = async () => {
    await run(async () => {
      await restoreAppliedEdit(projectPath, rec.id);
      const next = useDawStore.getState().project;
      const stillThere = next?.applied_edits.records.some(
        (r) => r.id === rec.id,
      );
      if (!stillThere) {
        setSelection(null);
      }
    });
  };

  const tlStart = rec.timeline_start ?? 0;
  const tlEnd = rec.timeline_end ?? tlStart;

  return (
    <ModifierInspector
      badge="Applied"
      title="Applied edit"
      subtitle={rec.operation}
      primaryActions={
        canRestore
          ? [
              {
                label: "Restore",
                variant: "primary",
                disabled: busy,
                onClick: () => void onRestore(),
              },
            ]
          : undefined
      }
      error={error}
      footer={
        rec.timeline_start != null ? (
          <InspectorSeekFooter
            seekSec={tlStart}
            playStart={tlStart}
            playEnd={tlEnd}
          />
        ) : undefined
      }
    >
      <DefinitionList>
        <DefItem label="Operation">{rec.operation}</DefItem>
        <DefItem label="Reason">{rec.reason ?? "Not provided"}</DefItem>
        <DefItem label="At">{rec.applied_at}</DefItem>
        {rec.source_start != null ? (
          <DefItem label="Source">
            {rec.source_start.toFixed(3)} – {rec.source_end?.toFixed(3)} s
          </DefItem>
        ) : null}
        {rec.timeline_start != null ? (
          <DefItem label="Timeline">
            {rec.timeline_start.toFixed(3)} – {rec.timeline_end?.toFixed(3)} s
          </DefItem>
        ) : null}
        {!canRestore ? (
          <DefItem label="Restore">
            Unavailable (no source clocks). Use History undo
          </DefItem>
        ) : null}
        {rec.boundary_mode ? (
          <DefItem label="Boundary">{rec.boundary_mode}</DefItem>
        ) : null}
        {Object.keys(rec.params ?? {}).length > 0 ? (
          <DefItem label="Params">
            <code>{JSON.stringify(rec.params)}</code>
          </DefItem>
        ) : null}
      </DefinitionList>
    </ModifierInspector>
  );
}
