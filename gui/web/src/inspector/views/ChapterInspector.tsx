import { useEffect, useState } from "react";
import { deleteChapter, updateChapter } from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import {
  Button,
  DefItem,
  DefinitionList,
  FieldRow,
  InspectorSeekFooter,
} from "../../ui";
import { formatTime } from "../../utils/time";
import { ModifierInspector } from "../ModifierInspector";

export function ChapterInspector({
  title,
  time,
}: {
  title: string;
  time: number;
}) {
  const { projectPath, setSelection } = useDaw((s) => ({
    projectPath: s.projectPath,
    setSelection: s.setSelection,
  }));
  const editable = !isShareProjectKey(projectPath);
  const { busy, error, setError, run } = useProjectMutation();
  const [titleStr, setTitleStr] = useState(title);
  const [timeStr, setTimeStr] = useState(String(time));

  useEffect(() => {
    setTitleStr(title);
    setTimeStr(String(time));
    setError(null);
  }, [title, time, setError]);

  const apply = async () => {
    const nextTime = Number.parseFloat(timeStr);
    if (!Number.isFinite(nextTime) || nextTime < 0) {
      setError("Time must be a non-negative number");
      return;
    }
    const nextTitle = titleStr.trim();
    if (!nextTitle) {
      setError("Title cannot be empty");
      return;
    }
    await run(async () => {
      await updateChapter(projectPath, time, title, nextTime, nextTitle);
      setSelection({ kind: "chapter", id: nextTitle, time: nextTime });
    });
  };

  const remove = async () => {
    await run(async () => {
      await deleteChapter(projectPath, time, title);
      setSelection(null);
    });
  };

  return (
    <ModifierInspector
      badge="Chapter"
      title={title}
      subtitle={formatTime(time)}
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
          seekSec={time}
          playStart={time}
          playEnd={time}
          showPlay={false}
        />
      }
    >
      <DefinitionList>
        <DefItem label="Title">
          {editable ? (
            <input
              type="text"
              value={titleStr}
              disabled={busy}
              onChange={(e) => setTitleStr(e.target.value)}
            />
          ) : (
            title
          )}
        </DefItem>
        <DefItem label="Time">
          {editable ? (
            <FieldRow>
              <input
                type="number"
                min={0}
                step={0.01}
                value={timeStr}
                disabled={busy}
                onChange={(e) => setTimeStr(e.target.value)}
              />
              <Button disabled={busy} onClick={() => void apply()}>
                Apply
              </Button>
            </FieldRow>
          ) : (
            formatTime(time)
          )}
        </DefItem>
      </DefinitionList>
    </ModifierInspector>
  );
}
