import { useEffect } from "react";
import { registerDawWebMcpTools } from "./agentic/webmcp";
import {
  registerDawCommands,
  setBladeCommandRunner,
} from "./commands/register";
import { useDesktopCloseGuard } from "./desktop/useDesktopCloseGuard";
import { HelpDialog } from "./home/HelpDialog";
import { useBladeCut } from "./hooks/useBladeCut";
import { useGuestSyncAndProjectPoll } from "./hooks/useGuestSyncAndProjectPoll";
import { useHostSync } from "./hooks/useHostSync";
import { usePipelineJob } from "./hooks/usePipelineJob";
import { usePointerType } from "./hooks/usePointerType";
import { useProjectBootstrap } from "./hooks/useProjectBootstrap";
import { useDawKeymapListener } from "./keymap/listener";
import { BounceDialog } from "./layout/BounceDialog";
import { CheatsheetDialogs } from "./layout/CheatsheetDialogs";
import { CutSpeechDialog } from "./layout/CutSpeechDialog";
import { HostMcpDialog } from "./layout/HostMcpDialog";
import { ShareDialog } from "./layout/ShareDialog";
import { StudioShell } from "./layout/StudioShell";
import { useRecordHostStore } from "./record/hostStore";
import { sendRecordHostCommand } from "./record/hostWire";
import { useRecordMonitor } from "./record/monitor/useRecordMonitor";
import { RecordPanel } from "./record/RecordPanel";
import { useHostKeeperCapture } from "./record/useHostKeeperCapture";
import { isShareProjectKey } from "./shareMode";
import { useDawStore } from "./state/dawStore";
import { selectPublishKey } from "./state/publishKey";
import type { DawState } from "./state/types";
import { pickDaw, useDaw } from "./state/useDaw";
import { FollowEngine, TransportEngine } from "./TransportEngine";
import { Button, ErrorScreen } from "./ui";

let commandsRegistered = false;

const selectDawAppFields = pickDaw(
  "projectPath",
  "setProject",
  "isPlaying",
  "applyAgentSession",
  "buildViewerSnapshot",
  "lastAppliedRevision",
  "lastAppliedCommandId",
  "pipelineJob",
  "setPipelineJob",
  "activityJob",
  "setActivityJob",
  "setActivityRunningCount",
  "hostMcpDialogOpen",
  "setHostMcpDialogOpen",
  "helpDialogOpen",
  "setHelpDialogOpen",
);

const selectDawAppDerived = (s: DawState) => ({
  hasProject: Boolean(s.project),
  projectName: s.project?.meta.name ?? null,
  suppressPublish: s.suppressPublish || s.sourcePreview !== null,
});

export function DawApp({ guestShare = false }: { guestShare?: boolean }) {
  const {
    projectPath,
    setProject,
    isPlaying,
    applyAgentSession,
    buildViewerSnapshot,
    lastAppliedRevision,
    lastAppliedCommandId,
    pipelineJob,
    setPipelineJob,
    activityJob,
    setActivityJob,
    setActivityRunningCount,
    hostMcpDialogOpen,
    setHostMcpDialogOpen,
    helpDialogOpen,
    setHelpDialogOpen,
  } = useDaw(selectDawAppFields);
  const { hasProject, projectName, suppressPublish } =
    useDaw(selectDawAppDerived);
  const publishKey = useDawStore(selectPublishKey);

  const { error: bootstrapError, retry: retryBootstrap } =
    useProjectBootstrap(projectPath);

  const syncEnabled = !guestShare && !isShareProjectKey(projectPath);
  const guestSyncEnabled = guestShare || isShareProjectKey(projectPath);
  const pipelineEnabled = syncEnabled;

  usePipelineJob(pipelineJob, setPipelineJob, {
    enabled: pipelineEnabled,
    activityJob,
    setActivityJob,
    setActivityRunningCount,
  });

  useHostSync(
    projectPath,
    applyAgentSession,
    buildViewerSnapshot,
    suppressPublish,
    lastAppliedRevision,
    lastAppliedCommandId,
    isPlaying,
    publishKey,
    syncEnabled,
  );
  useGuestSyncAndProjectPoll(projectPath, applyAgentSession, setProject, {
    hostSyncEnabled: syncEnabled,
    guestSyncEnabled,
  });
  usePointerType();

  useEffect(() => {
    if (!commandsRegistered) {
      registerDawCommands();
      commandsRegistered = true;
    }
  }, []);

  useEffect(() => registerDawWebMcpTools(), []);

  const blade = useBladeCut();
  useEffect(() => {
    setBladeCommandRunner({
      requestCut: blade.requestCut,
      confirmPending: blade.confirmPending,
      cancelPending: blade.cancelPending,
    });
    return () => setBladeCommandRunner(null);
  }, [blade.requestCut, blade.confirmPending, blade.cancelPending]);

  useDawKeymapListener();
  const hostKeeper = useHostKeeperCapture(
    !guestShare && !isShareProjectKey(projectPath),
  );
  const hostStartPending = useRecordHostStore((s) => s.startPending);
  useDesktopCloseGuard(
    hostStartPending ||
      hostKeeper.recordingLocally ||
      hostKeeper.finalizing ||
      hostKeeper.snapshot?.state === "recording" ||
      hostKeeper.snapshot?.state === "paused",
    "host",
    hostKeeper.snapshot !== null,
  );
  const hostMonitor = useRecordMonitor({
    enabled: hostKeeper.monitorEnabled,
    localId: hostKeeper.snapshot ? "p_host" : null,
    role: "host",
    snapshot: hostKeeper.snapshot,
    localStream: hostKeeper.stream,
    muted: hostKeeper.muted,
    send: (payload) => sendRecordHostCommand("Signal", payload),
  });

  useEffect(() => {
    if (!projectName) {
      return;
    }
    const previous = document.title;
    document.title = projectName;
    return () => {
      document.title = previous;
    };
  }, [projectName]);

  const engines = (
    <>
      <TransportEngine />
      <FollowEngine />
    </>
  );

  if (bootstrapError && !hasProject) {
    return (
      <>
        {engines}
        <ErrorScreen message={bootstrapError} />
      </>
    );
  }

  return (
    <>
      {engines}
      <div data-daw-app-chrome>
        {bootstrapError && hasProject ? (
          <div className="guest-banner" role="alert">
            Could not load transcript and history. {bootstrapError}{" "}
            <Button variant="link" onClick={retryBootstrap}>
              Retry
            </Button>
          </div>
        ) : null}
        <StudioShell guestShare={guestShare} />
      </div>
      <CheatsheetDialogs />
      <BounceDialog />
      <CutSpeechDialog />
      <ShareDialog />
      <RecordPanel
        recordingLocally={hostKeeper.recordingLocally}
        keeperFinalizing={hostKeeper.finalizing}
        keeperError={hostKeeper.error}
        onRetryKeeper={hostKeeper.retry}
        micError={hostKeeper.micError}
        micPending={hostKeeper.micPending}
        micStatus={hostKeeper.micStatus}
        hearing={hostMonitor.hearing}
        monitorError={hostMonitor.error}
        stream={hostKeeper.stream}
        micLost={hostKeeper.micLost}
        onRetryMic={hostKeeper.retryMic}
        onCheckMic={hostKeeper.checkMic}
        micCheckFailed={hostKeeper.micCheckFailed}
      />
      <HostMcpDialog
        open={hostMcpDialogOpen}
        onClose={() => setHostMcpDialogOpen(false)}
        hasProject={hasProject}
      />
      <HelpDialog
        open={helpDialogOpen}
        onClose={() => setHelpDialogOpen(false)}
      />
    </>
  );
}
