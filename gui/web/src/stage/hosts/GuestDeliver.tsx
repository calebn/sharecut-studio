import { useShallow } from "zustand/react/shallow";
import { useViewportClass } from "../../hooks/useViewportClass";
import { ArchiveLink } from "../../stages/deliver/ArchiveLink";
import { DeliverSection } from "../../stages/deliver/DeliverSection";
import { ExportedFiles } from "../../stages/deliver/ExportedFiles";
import { FeedPanel } from "../../stages/deliver/FeedPanel";
import { feedAccessOf } from "../../stages/deliver/feedLogic";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import { Button, InlineError } from "../../ui";
import { canEditStage } from "../../utils/can";
import { useStageScroll } from "../useStageScroll";
import { openFeedSource } from "./feedSource";
import { HostBody } from "./HostBody";
import { hostStateOf, type LoadFailure } from "./hostModels";
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
  const canDownload = canEditStage(role);
  const files = useDeliverFiles(canDownload ? projectPath : null, {
    access: "download",
    refreshKey: project?.history.head_id,
    watchGuestPublication: state === "ready" && canDownload,
  });
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
                <DeliverSection
                  title="Files"
                  action={
                    files.archive ? (
                      <ArchiveLink
                        archive={files.archive}
                        className="dv-file-action"
                        iconSize={16}
                        onStarted={files.onStarted}
                      />
                    ) : undefined
                  }
                >
                  {files.currentLoad === "loading" ? (
                    <p className="dv-note" role="status">
                      Loading exported files…
                    </p>
                  ) : null}
                  <InlineError
                    origin="state"
                    message={
                      files.currentLoad === "error"
                        ? "Exported files could not be loaded."
                        : null
                    }
                  />
                  {files.currentLoad === "error" ? (
                    <Button
                      variant="link"
                      aria-label="Retry loading exported files"
                      onClick={files.reload}
                    >
                      Retry
                    </Button>
                  ) : null}
                  {files.currentLoad === "ready" && files.files.length === 0 ? (
                    <p className="dv-note">{NO_FILES}</p>
                  ) : null}
                  {files.files.length > 0 ? (
                    <ExportedFiles
                      files={files.files}
                      access="download"
                      grouped
                      onStarted={files.onStarted}
                    />
                  ) : null}
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
