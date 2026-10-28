import { useEffect, useState } from "react";
import { registerDawWebMcpTools } from "./agentic/webmcp";
import { registerDawCommands } from "./commands/register";
import { useDesktopCloseGuard } from "./desktop/useDesktopCloseGuard";
import { AskDialog } from "./feedback/AskDialog";
import { FeedbackToast } from "./feedback/FeedbackToast";
import { HelpDialog } from "./home/HelpDialog";
import { useAutoRefreshMix } from "./hooks/useAutoRefreshMix";
import { useGuestSyncAndProjectPoll } from "./hooks/useGuestSyncAndProjectPoll";
import { useHostSync } from "./hooks/useHostSync";
import { usePendingMixWarm } from "./hooks/usePendingMixWarm";
import { usePipelineJob } from "./hooks/usePipelineJob";
import { usePointerType } from "./hooks/usePointerType";
import { useProjectBootstrap } from "./hooks/useProjectBootstrap";
import { useDawKeymapListener } from "./keymap/listener";
import { ModelsDialog } from "./models";
import { HostRoomProvider } from "./record/hostRoomContext";
import { useRecordHostStore } from "./record/hostStore";
import { sendRecordHostCommand } from "./record/hostWire";
import { useRecordMonitor } from "./record/monitor/useRecordMonitor";
import { RecordPanel } from "./record/RecordPanel";
import { useHostKeeperCapture } from "./record/useHostKeeperCapture";
import { useHostRoom } from "./record/useHostRoom";
import { isShareProjectKey } from "./shareMode";
import { BounceDialog } from "./stage/dialogs/BounceDialog";
import { CheatsheetDialogs } from "./stage/dialogs/CheatsheetDialogs";
import { HostMcpDialog } from "./stage/dialogs/HostMcpDialog";
import { ShareDialog } from "./stage/dialogs/ShareDialog";
import { SplitSpeakersDialog } from "./stage/dialogs/SplitSpeakersDialog";
import { EDIT_SHEETS } from "./stage/edit/editSheets";
import { StageFrame } from "./stage/frame/StageFrame";
import { useLandingStage } from "./stage/frame/useLandingStage";
import { ExportFlowProvider } from "./stage/hosts/exportFlow";
import { StageHost } from "./stage/hosts/StageHost";
import { useDawStore } from "./state/dawStore";
import { selectPublishKey } from "./state/publishKey";
import type { DawState } from "./state/types";
import { pickDaw, useDaw } from "./state/useDaw";
import { FollowEngine, TransportEngine } from "./TransportEngine";
import { usePressedControl } from "./ui";

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
  "setHostMcpDialogOpen",
  "setHelpDialogOpen",
  "setModelsDialogOpen",
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
    setHostMcpDialogOpen,
    setHelpDialogOpen,
    setModelsDialogOpen,
  } = useDaw(selectDawAppFields);
  const hostMcpDialogOpen = useDaw((s) => s.chrome.hostMcpDialogOpen);
  const helpDialogOpen = useDaw((s) => s.chrome.helpDialogOpen);
  const modelsDialogOpen = useDaw((s) => s.chrome.modelsDialogOpen);
  const { hasProject, projectName, suppressPublish } =
    useDaw(selectDawAppDerived);
  const [feedbackHost, setFeedbackHost] = useState<HTMLDivElement | null>(null);
  const publishKey = useDawStore(selectPublishKey);

  const {
    error: bootstrapError,
    recovering: bootstrapRecovering,
    retry: retryBootstrap,
  } = useProjectBootstrap(projectPath);

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
  useAutoRefreshMix(syncEnabled);
  usePendingMixWarm(syncEnabled);
  usePointerType();
  usePressedControl();
  useLandingStage();

  useEffect(() => {
    if (!commandsRegistered) {
      registerDawCommands();
      commandsRegistered = true;
    }
  }, []);

  useEffect(() => registerDawWebMcpTools(), []);

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

  const recordPanelOpen = useDaw((s) => s.chrome.recordPanelOpen);
  const hostRoom = useHostRoom(
    {
      recordingLocally: hostKeeper.recordingLocally,
      keeperFinalizing: hostKeeper.finalizing,
      keeperError: hostKeeper.error,
      onRetryKeeper: hostKeeper.retry,
      micError: hostKeeper.micError,
      micPending: hostKeeper.micPending,
      micStatus: hostKeeper.micStatus,
      hearing: hostMonitor.hearing,
      monitorError: hostMonitor.error,
      stream: hostKeeper.stream,
      micLost: hostKeeper.micLost,
      onRetryMic: hostKeeper.retryMic,
      onCheckMic: hostKeeper.checkMic,
      micCheckFailed: hostKeeper.micCheckFailed,
    },
    { hydrate: syncEnabled && recordPanelOpen },
  );

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

  const loadFailure =
    bootstrapRecovering && hasProject
      ? {
          message: "The server is still working. Retrying…",
          onRetry: retryBootstrap,
          recovering: true,
        }
      : bootstrapError
        ? { message: bootstrapError, onRetry: retryBootstrap }
        : null;

  const engines = (
    <>
      <TransportEngine />
      <FollowEngine />
    </>
  );

  return (
    <HostRoomProvider value={hostRoom}>
      <ExportFlowProvider>
        {engines}
        <div data-daw-app-chrome>
          <StageFrame
            guestShare={guestShare}
            loadFailure={loadFailure}
            attentionHost={feedbackHost}
            sheets={EDIT_SHEETS}
          >
            <StageHost
              guestShare={guestShare}
              loadFailure={loadFailure}
              feedbackHostRef={setFeedbackHost}
            />
          </StageFrame>
        </div>
        <CheatsheetDialogs />
        <BounceDialog />
        <SplitSpeakersDialog />
        <ShareDialog />
        <RecordPanel />
        <HostMcpDialog
          open={hostMcpDialogOpen}
          onClose={() => setHostMcpDialogOpen(false)}
          hasProject={hasProject}
        />
        <HelpDialog
          open={helpDialogOpen}
          onClose={() => setHelpDialogOpen(false)}
        />
        {syncEnabled ? (
          <ModelsDialog
            open={modelsDialogOpen}
            onClose={() => setModelsDialogOpen(false)}
          />
        ) : null}
        <AskDialog />
        <FeedbackToast host={feedbackHost} />
      </ExportFlowProvider>
    </HostRoomProvider>
  );
}
