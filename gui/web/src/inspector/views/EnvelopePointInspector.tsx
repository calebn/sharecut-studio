import { useEffect, useState } from "react";
import { setEnvelope } from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { AutomationPoint } from "../../types/project";
import {
  Button,
  DefItem,
  DefinitionList,
  FieldRow,
  InspectorSeekFooter,
} from "../../ui";
import {
  clampEnvelopeValue,
  replaceEnvelopePoint,
  sortedVolumePoints,
} from "../../utils/envelopes";
import { formatTime } from "../../utils/time";
import { ModifierInspector } from "../ModifierInspector";

export function EnvelopePointInspector({
  trackId,
  index,
}: {
  trackId: string;
  index: number;
}) {
  const { project, projectPath, selection, setSelection } = useDaw();
  const editable = !isShareProjectKey(projectPath);
  const { busy, error, setError, run } = useProjectMutation();
  const points = sortedVolumePoints(project?.envelopes, trackId);
  const point = points[index];
  const [timeStr, setTimeStr] = useState(point ? String(point.time) : "");
  const [valueStr, setValueStr] = useState(point ? String(point.value) : "");

  useEffect(() => {
    if (!point) {
      return;
    }
    setTimeStr(String(point.time));
    setValueStr(String(point.value));
  }, [point, trackId, index]);

  useEffect(() => {
    setError(null);
  }, [trackId, index, selection, setError]);

  if (!point) {
    return <aside className="inspector">Envelope point not found</aside>;
  }

  const commitPoints = async (
    next: AutomationPoint[],
    nextIndex: number | null,
  ) => {
    await run(async () => {
      await setEnvelope(projectPath, trackId, next);
      if (nextIndex == null) {
        setSelection(null);
      } else {
        setSelection({
          kind: "envelopePoint",
          trackId,
          index: nextIndex,
        });
      }
    });
  };

  const apply = async () => {
    if (busy) {
      return;
    }
    const time = Number.parseFloat(timeStr);
    const value = Number.parseFloat(valueStr);
    if (!Number.isFinite(time) || time < 0) {
      setError("Time must be a non-negative number");
      return;
    }
    if (!Number.isFinite(value)) {
      setError("Value must be a finite number");
      return;
    }
    const latest = sortedVolumePoints(
      useDawStore.getState().project?.envelopes,
      trackId,
    );
    const current = latest[index];
    if (!current || current.id !== point.id || current.time !== point.time) {
      setError("Envelope point changed; select it again");
      return;
    }
    const replaced = replaceEnvelopePoint(latest, index, {
      id: current.id,
      time,
      value: clampEnvelopeValue(value),
    });
    await commitPoints(replaced.points, Math.max(0, replaced.index));
  };

  const remove = async () => {
    if (busy) {
      return;
    }
    const latest = sortedVolumePoints(
      useDawStore.getState().project?.envelopes,
      trackId,
    );
    if (latest.length < 2) {
      setError("Keep at least one envelope point");
      return;
    }
    const current = latest[index];
    if (!current || current.id !== point.id || current.time !== point.time) {
      setError("Envelope point changed; select it again");
      return;
    }
    const next = latest.filter((_, i) => i !== index);
    await commitPoints(next, null);
  };

  return (
    <ModifierInspector
      badge="Envelope"
      title={trackId}
      subtitle={formatTime(point.time)}
      primaryActions={
        editable && points.length > 1
          ? [
              {
                label: "Delete",
                variant: "danger",
                disabled: busy,
                onClick: () => void remove(),
              },
            ]
          : undefined
      }
      error={error}
      footer={
        <InspectorSeekFooter
          seekSec={point.time}
          playStart={point.time}
          playEnd={point.time}
          showPlay={false}
        />
      }
    >
      {editable ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          <DefinitionList>
            <DefItem label="Time">
              <FieldRow>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={timeStr}
                  disabled={busy}
                  aria-label="Envelope time"
                  onChange={(e) => setTimeStr(e.target.value)}
                />
              </FieldRow>
            </DefItem>
            <DefItem label="Value">
              <FieldRow>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={valueStr}
                  disabled={busy}
                  aria-label="Envelope value"
                  onChange={(e) => setValueStr(e.target.value)}
                />
                <Button type="submit" disabled={busy}>
                  Apply
                </Button>
              </FieldRow>
            </DefItem>
          </DefinitionList>
        </form>
      ) : (
        <DefinitionList>
          <DefItem label="Time">{formatTime(point.time)}</DefItem>
          <DefItem label="Value">{point.value.toFixed(2)}</DefItem>
        </DefinitionList>
      )}
    </ModifierInspector>
  );
}
