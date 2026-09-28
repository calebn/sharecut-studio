import { updateChapter, updateSocialClip } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { ChapterMarker } from "../types/project";
import { MarkerLaneView, type MarkerLaneViewProps } from "./MarkerLaneView";

type MarkerLaneProps = Omit<
  MarkerLaneViewProps,
  "editable" | "onMoveChapter" | "onMoveSocial"
>;

/** Live wiring: host-only drags commit UpdateChapter / UpdateSocialClip. */
export function MarkerLane(props: MarkerLaneProps) {
  const { projectPath, setSelection } = useDaw((s) => ({
    projectPath: s.projectPath,
    setSelection: s.setSelection,
  }));
  const onMoveChapter = (chapter: ChapterMarker, nextTime: number) => {
    void (async () => {
      await updateChapter(
        projectPath,
        chapter.time,
        chapter.title,
        nextTime,
        chapter.title,
      );
      setSelection({ kind: "chapter", id: chapter.title, time: nextTime });
    })();
  };
  const onMoveSocial = (id: string, start: number, end: number) => {
    void updateSocialClip(projectPath, id, start, end);
  };
  return (
    <MarkerLaneView
      {...props}
      editable={!isShareProjectKey(projectPath)}
      onMoveChapter={onMoveChapter}
      onMoveSocial={onMoveSocial}
    />
  );
}
