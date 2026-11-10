import { useEffect } from "react";
import { updateChapter } from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { InlineEdit } from "../../system/InlineEdit";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import type { Selection } from "../../types/project";
import { note } from "./sheetNote";

export function useChapterSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { projectPath, duration, followChapter } = useDaw((s) => ({
    projectPath: s.projectPath,
    duration: s.project?.timeline_duration_sec ?? 0,
    followChapter: s.followChapter,
  }));
  const chapter = selection?.kind === "chapter" ? selection : null;
  const { busy, error, setError, run } = useProjectMutation();
  useEffect(() => {
    setError(null);
  }, [chapter?.id, chapter?.time, setError]);
  if (!chapter) return null;

  const { id: title, time } = chapter;
  const editable = !isShareProjectKey(projectPath);

  const save = async (nextTime: number, nextTitle: string) => {
    if (nextTime === time && nextTitle === title) return;
    await run(async () => {
      await updateChapter(projectPath, time, title, nextTime, nextTitle);
      followChapter(chapter, {
        kind: "chapter",
        id: nextTitle,
        time: nextTime,
      });
    });
  };

  const commitTitle = (text: string) => {
    const next = text.trim();
    if (next === title) return;
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
            <InlineEdit
              label="Title"
              value={title}
              onCommit={commitTitle}
              readOnly={busy}
              className="inspector-text-field"
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
              max={duration > 0 ? duration : undefined}
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
