import { useEffect } from "react";
import { updateSocialClip, updateSocialClipDetails } from "../../api";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { DotMeter } from "../../system/DotMeter";
import { InlineEdit } from "../../system/InlineEdit";
import type { InspectorSection } from "../../system/InspectorSheet";
import { MARKER_MIN_SPAN } from "../../system/MarkerLane";
import { ScrubField } from "../../system/ScrubField";
import type { Selection } from "../../types/project";
import { shownTitle } from "../../utils/clipTitle";
import { note } from "./sheetNote";

export function useSocialSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { project, projectPath } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
  }));
  const duration = project?.timeline_duration_sec ?? 0;
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
  const normalMinEnd = clip.start + MARKER_MIN_SPAN;
  const shortClip = clip.end < normalMinEnd;
  const minEnd = shortClip ? clip.end : normalMinEnd;
  const maxStart = Math.max(
    0,
    shortClip ? clip.start : clip.end - MARKER_MIN_SPAN,
  );
  const maxEnd =
    duration > minEnd
      ? duration
      : shortClip && duration > 0
        ? minEnd
        : undefined;

  const save = async (start: number, end: number) => {
    if (start === clip.start && end === clip.end) return;
    await run(async () => {
      await updateSocialClip(projectPath, clip.id, start, end);
    });
  };

  const edge = (
    which: "start" | "end",
    min: number,
    max: number | undefined,
  ) => (
    <ScrubField
      label={which === "start" ? "Start" : "End"}
      value={clip[which]}
      unit="s"
      step={0.01}
      decimals={2}
      min={min}
      max={max}
      exactBounds={shortClip}
      skipUnchanged
      readOnly={!editable || busy}
      busy={busy}
      onCommit={(next) =>
        void save(
          which === "start" ? next : clip.start,
          which === "end" ? next : clip.end,
        )
      }
    />
  );

  const retitle = (text: string) => {
    const next = text.trim();
    if (next === (clip.title_suggestion ?? "")) return;
    void run(() =>
      updateSocialClipDetails(projectPath, clip.id, { title: next }),
    );
  };

  return [
    {
      id: "social",
      rows: [
        {
          id: "title",
          label: "Title",
          control: editable ? (
            <InlineEdit
              label="Title"
              value={clip.title_suggestion ?? ""}
              placeholder="Untitled clip"
              maxLength={200}
              onCommit={retitle}
              readOnly={busy}
              trim
              className="inspector-text-field"
            />
          ) : (
            shownTitle(clip.title_suggestion)
          ),
        },
        {
          id: "start",
          label: "Start",
          control: edge("start", 0, maxStart),
        },
        {
          id: "end",
          label: "End",
          control: edge("end", minEnd, maxEnd),
        },
        ...(clip.score > 0
          ? [
              {
                id: "quality",
                label: "Quality",
                control: (
                  <DotMeter
                    label="Quality"
                    value={clip.score}
                    showLabel={false}
                  />
                ),
              },
            ]
          : []),
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
