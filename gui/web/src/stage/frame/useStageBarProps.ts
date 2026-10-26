import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf, stagesForRole } from "../../state/stageRoutes";
import type { StageBarProps } from "../../system/StageBar";
import type { StageId } from "../../system/verbs";
import { useRecordLive, useStageBadges } from "./useStageBadges";

/**
 * The Stage bar for the header (`form: "bar"`) and the phone tab bar
 * (`form: "tabs"`). Undefined when the role has one stage: a Viewer or
 * Commenter link has nothing to switch between.
 */
export function useStageBarProps(): StageBarProps | undefined {
  const { stage, guestMode } = useDawStore(
    useShallow((s) => ({ stage: s.stage, guestMode: s.guestMode })),
  );
  const badges = useStageBadges();
  const live = useRecordLive();
  const stages = stagesForRole(stageRoleOf(guestMode));
  if (stages.length < 2) return undefined;
  return {
    active: stage,
    stages,
    badges,
    live,
    // The command applies the role gate, drops a follow and snapshots the view.
    onSelect: (next: StageId) => runPointerCommand(`stage.${next}`),
  };
}
