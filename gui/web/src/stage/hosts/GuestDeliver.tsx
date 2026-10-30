import { useShallow } from "zustand/react/shallow";
import { useViewportClass } from "../../hooks/useViewportClass";
import { feedAccessOf } from "../../stages/deliver/feedLogic";
import { FeedPanel } from "../../stages/deliver/FeedPanel";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";
import { openFeedSource } from "./feedSource";
import { HostBody } from "./HostBody";
import { hostStateOf } from "./hostModels";

type Props = { loadFailure?: LoadFailure | null };

/**
 * What a share link sees of Deliver: the Podcast listing alone. Exporting, bouncing and sharing
 * stay with the host. An Editor link edits the listing; a link that cannot edit only reads it.
 */
export function GuestDeliver({ loadFailure }: Props) {
  const { project, projectPath, guestMode } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
    })),
  );
  const shell = useViewportClass();
  const scrollRef = useStageScroll("deliver", "body", ".dv-page");
  const state = hostStateOf(project, loadFailure);
  return (
    <HostBody
      stage="deliver"
      shell={shell}
      state={state}
      failure={loadFailure}
      scrollRef={scrollRef}
    >
      {state === "ready" && projectPath ? (
        <div className="stage-host-deliver">
          <div
            className="dv-stage"
            data-layout={shell === "phone" ? "phone" : "desktop"}
          >
            <section className="dv-page" aria-label="Deliver">
              <FeedPanel
                projectPath={projectPath}
                access={feedAccessOf(stageRoleOf(guestMode))}
                refreshKey={project?.history.head_id}
                onOpenSource={openFeedSource}
              />
            </section>
          </div>
        </div>
      ) : null}
    </HostBody>
  );
}
