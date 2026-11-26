import { useShallow } from "zustand/react/shallow";
import { useEditorCutTotal } from "../../hooks/useEditorCutTotal";
import { useViewportClass } from "../../hooks/useViewportClass";
import { ArchiveLink } from "../../stages/deliver/ArchiveLink";
import { DeliverSection } from "../../stages/deliver/DeliverSection";
import { ExportedFiles } from "../../stages/deliver/ExportedFiles";
import { RUNNING_REASON } from "../../stages/deliver/exportedFileModel";
import { FeedPanel } from "../../stages/deliver/FeedPanel";
import { feedAccessOf } from "../../stages/deliver/feedLogic";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import { SystemIcon } from "../../system/SystemIcon";
import { formatCutsSaved, hasCutsSaved } from "../../system/seconds";
import { iconOf, verbOf } from "../../system/verbDisplay";
import { Button, InlineError } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import { canEditStage } from "../../utils/can";
import { useStageScroll } from "../useStageScroll";
import { openFeedSource } from "./feedSource";
import { HostBody } from "./HostBody";
import { hostStateOf, type LoadFailure } from "./hostModels";
import { useDeliverFiles } from "./useDeliverFiles";
import { useGuestExport } from "./useGuestExport";

type Props = { loadFailure?: LoadFailure | null };

const NO_FILES_ASK = "No exported files yet. Ask the host to export.";
const NO_FILES_EXPORT = "No exported files yet. Use Export to make them.";
const EXPORT_OFF = "The host has not turned on exports from share links.";
const EXPORT_STARTING = "Starting export.";
const EXPORT_REPLACES =
  "Export replaces files with the same name, including the feed.";

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
  const removedSeconds = useEditorCutTotal();
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
  const guestExport = useGuestExport(canDownload ? projectPath : null, files);
  const exportOff = files.guestRender === false;
  const exportReason = exportOff
    ? EXPORT_OFF
    : files.exporting
      ? RUNNING_REASON
      : guestExport.starting
        ? EXPORT_STARTING
        : undefined;
  const exportNote = useDisabledReasonNote(exportReason, "dv-note");
  const exportVerb = verbOf("export");
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
                    <div className="dv-section-actions">
                      {files.archive ? (
                        <ArchiveLink
                          archive={files.archive}
                          className="dv-file-action"
                          iconSize={16}
                          running={files.exporting}
                          onStarted={files.onStarted}
                        />
                      ) : null}
                      <Button
                        className="dv-file-action"
                        disabledReason={exportReason}
                        {...exportNote.describedBy}
                        onClick={guestExport.start}
                      >
                        <SystemIcon name={iconOf("export")} size={16} />
                        {exportVerb.label}
                      </Button>
                    </div>
                  }
                >
                  {exportNote.note}
                  <p className="dv-note">{EXPORT_REPLACES}</p>
                  <InlineError origin="state" message={guestExport.error} />
                  {removedSeconds != null ? (
                    <p className="dv-note">
                      {hasCutsSaved(removedSeconds)
                        ? `Edits saved ${formatCutsSaved(removedSeconds)}`
                        : formatCutsSaved(removedSeconds)}
                    </p>
                  ) : null}
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
                  {files.currentLoad === "ready" &&
                  files.files.length === 0 &&
                  (exportOff || (!files.exporting && !guestExport.starting)) ? (
                    <p className="dv-note">
                      {exportOff ? NO_FILES_ASK : NO_FILES_EXPORT}
                    </p>
                  ) : null}
                  {files.files.length > 0 ? (
                    <ExportedFiles
                      files={files.files}
                      access="download"
                      grouped
                      running={files.exporting}
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
