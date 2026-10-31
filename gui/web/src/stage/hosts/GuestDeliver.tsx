import { useShallow } from "zustand/react/shallow";
import { useViewportClass } from "../../hooks/useViewportClass";
import { DeliverSection } from "../../stages/deliver/DeliverSection";
import { ExportedFiles } from "../../stages/deliver/ExportedFiles";
import { FeedPanel } from "../../stages/deliver/FeedPanel";
import { feedAccessOf } from "../../stages/deliver/feedLogic";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";
import { openFeedSource } from "./feedSource";
import { HostBody } from "./HostBody";
import { hostStateOf } from "./hostModels";
import { useDeliverFiles } from "./useDeliverFiles";

type Props = { loadFailure?: LoadFailure | null };

const NO_FILES = "No exported files yet. Ask the host to export.";

/**
 * What a share link sees of Deliver: the Podcast listing, and for an Editor link the files the
 * host exported, to download. Bouncing and sharing stay with the host. An Editor link edits the
 * listing; a link that cannot edit only reads it, and a Viewer or Commenter link sees no files.
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
  const role = stageRoleOf(guestMode);
  const canDownload = role === "editor";
  const files = useDeliverFiles(
    canDownload ? projectPath : null,
    "download",
    project?.history.head_id,
  );
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
              {canDownload ? (
                <DeliverSection title="Files">
                  {files.load === "ready" && files.files.length === 0 ? (
                    <p className="dv-note">{NO_FILES}</p>
                  ) : (
                    <ExportedFiles
                      files={files.files}
                      access="download"
                      grouped
                      onStarted={files.onStarted}
                    />
                  )}
                </DeliverSection>
              ) : null}
              <FeedPanel
                projectPath={projectPath}
                access={feedAccessOf(role)}
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
