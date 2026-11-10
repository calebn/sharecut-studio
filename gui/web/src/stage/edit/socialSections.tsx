import { useEffect } from "react";
import { updateSocialClip } from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import type { Selection } from "../../types/project";
import { note } from "./sheetNote";

const END_BEFORE_START = "End must be greater than start";

export function useSocialSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { project, projectPath } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
  }));
  const { busy, error, setError, run } = useProjectMutation();
  const id = selection?.kind === "social" ? selection.id : null;
  const clip = (project?.social_clips ?? []).find((c) => c.id === id);
  useEffect(() => {
    setError(null);
  }, [id, clip?.start, clip?.end, setError]);
  if (id === null) return null;
  if (!clip)
    return [
      {
        id: "gone",
        rows: [{ id: "gone", control: note("Social clip not found") }],
      },
    ];

  const editable = !isShareProjectKey(projectPath);

  const save = async (start: number, end: number) => {
    if (start === clip.start && end === clip.end) return;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setError(END_BEFORE_START);
      return;
    }
    await run(async () => {
      await updateSocialClip(projectPath, clip.id, start, end);
    });
  };

  const edge = (which: "start" | "end") => (
    <ScrubField
      label={which === "start" ? "Start" : "End"}
      value={clip[which]}
      unit="s"
      step={0.01}
      decimals={2}
      min={0}
      skipUnchanged
      readOnly={!editable || busy}
      onCommit={(next) =>
        void save(
          which === "start" ? next : clip.start,
          which === "end" ? next : clip.end,
        )
      }
    />
  );

  return [
    {
      id: "social",
      rows: [
        {
          id: "title",
          label: "Title",
          control: clip.title_suggestion ?? clip.id,
        },
        { id: "start", label: "Start", control: edge("start") },
        { id: "end", label: "End", control: edge("end") },
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
