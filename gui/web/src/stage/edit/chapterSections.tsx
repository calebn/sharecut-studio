import { type KeyboardEvent, useEffect, useState } from "react";
import { updateChapter } from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import type { Selection } from "../../types/project";
import { note } from "./sheetNote";

export function useChapterSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { projectPath, setSelection } = useDaw((s) => ({
    projectPath: s.projectPath,
    setSelection: s.setSelection,
  }));
  const chapter = selection?.kind === "chapter" ? selection : null;
  const { busy, error, setError, run } = useProjectMutation();
  const [titleStr, setTitleStr] = useState(chapter?.id ?? "");
  useEffect(() => {
    setTitleStr(chapter?.id ?? "");
    setError(null);
  }, [chapter?.id, chapter?.time, setError]);
  if (!chapter) return null;

  const { id: title, time } = chapter;
  const editable = !isShareProjectKey(projectPath);

  const save = async (nextTime: number, nextTitle: string) => {
    if (nextTime === time && nextTitle === title) return;
    await run(async () => {
      await updateChapter(projectPath, time, title, nextTime, nextTitle);
      setSelection({ kind: "chapter", id: nextTitle, time: nextTime });
    });
  };

  const commitTitle = () => {
    const next = titleStr.trim();
    if (next === title) {
      setTitleStr(title);
      return;
    }
    if (!next) {
      setError("Title cannot be empty");
      return;
    }
    void save(time, next);
  };

  return [
    {
      id: "chapter",
      rows: [
        {
          id: "title",
          label: "Title",
          control: editable ? (
            <input
              className="track-sheet-field"
              aria-label="Title"
              value={titleStr}
              disabled={busy}
              onChange={(e) => setTitleStr(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          ) : (
            title
          ),
        },
        {
          id: "time",
          label: "Time",
          control: (
            <ScrubField
              label="Time"
              value={time}
              unit="s"
              step={0.01}
              decimals={2}
              min={0}
              skipUnchanged
              readOnly={!editable || busy}
              onCommit={(next) => void save(next, title)}
            />
          ),
        },
        ...(error
          ? [
              {
                id: "error",
                control: note(error, "alert"),
              },
            ]
          : []),
      ],
    },
  ];
}
