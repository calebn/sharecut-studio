import { useEffect, useState } from "react";
import { deleteSocialClip, updateSocialClip } from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { SocialClipView } from "../../types/project";
import {
  Button,
  DefItem,
  DefinitionList,
  FieldRow,
  InspectorSeekFooter,
} from "../../ui";
import { formatTime } from "../../utils/time";
import { ModifierInspector } from "../ModifierInspector";

export function SocialClipInspector({
  clip,
}: {
  clip: SocialClipView;
  onSeek: (sec: number) => void;
}) {
  const { projectPath, setSelection } = useDaw((s) => ({
    projectPath: s.projectPath,
    setSelection: s.setSelection,
  }));
  const editable = !isShareProjectKey(projectPath);
  const { busy, error, setError, run } = useProjectMutation();
  const [startStr, setStartStr] = useState(String(clip.start));
  const [endStr, setEndStr] = useState(String(clip.end));

  useEffect(() => {
    setStartStr(String(clip.start));
    setEndStr(String(clip.end));
    setError(null);
  }, [clip.id, clip.start, clip.end, setError]);

  const apply = async () => {
    const start = Number.parseFloat(startStr);
    const end = Number.parseFloat(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setError("End must be greater than start");
      return;
    }
    await run(async () => {
      await updateSocialClip(projectPath, clip.id, start, end);
    });
  };

  const remove = async () => {
    await run(async () => {
      await deleteSocialClip(projectPath, clip.id);
      setSelection(null);
    });
  };

  return (
    <ModifierInspector
      badge="Social"
      title={clip.title_suggestion ?? clip.id}
      subtitle={clip.track_id}
      primaryActions={
        editable
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
          seekSec={clip.start}
          playStart={clip.start}
          playEnd={clip.end}
          seekLabel="Seek to start"
          showPlay={false}
        />
      }
    >
      <DefinitionList>
        <DefItem label="Title">{clip.title_suggestion ?? clip.id}</DefItem>
        <DefItem label="Track">{clip.track_id}</DefItem>
        <DefItem label="Timeline">
          {editable ? (
            <FieldRow>
              <input
                type="number"
                min={0}
                step={0.01}
                value={startStr}
                disabled={busy}
                aria-label="Social clip start"
                onChange={(e) => setStartStr(e.target.value)}
              />
              <span>–</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={endStr}
                disabled={busy}
                aria-label="Social clip end"
                onChange={(e) => setEndStr(e.target.value)}
              />
              <Button disabled={busy} onClick={() => void apply()}>
                Apply
              </Button>
            </FieldRow>
          ) : (
            <>
              {formatTime(clip.start)} – {formatTime(clip.end)}
            </>
          )}
        </DefItem>
        <DefItem label="Score">{clip.score.toFixed(2)}</DefItem>
        <DefItem label="Approved">{clip.approved ? "yes" : "no"}</DefItem>
        <DefItem label="Review">
          {clip.review_required ? "required" : "no"}
        </DefItem>
      </DefinitionList>
    </ModifierInspector>
  );
}
