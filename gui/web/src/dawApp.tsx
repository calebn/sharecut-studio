import { useEffect } from "react";
import { registerDawWebMcpTools } from "./agentic/webmcp";
import { registerDawCommands } from "./commands/register";
import { useDesktopCloseGuard } from "./desktop/useDesktopCloseGuard";
import { FeedbackToast } from "./feedback/FeedbackToast";
import { openGuides } from "./commands/host";
import { HelpDialog } from "./home/HelpDialog";
import { useAutoRefreshMix } from "./hooks/useAutoRefreshMix";
import { useGuestSyncAndProjectPoll } from "./hooks/useGuestSyncAndProjectPoll";
import { useHostSync } from "./hooks/useHostSync";
import { usePendingMixWarm } from "./hooks/usePendingMixWarm";
import { usePipelineJob } from "./hooks/usePipelineJob";
import { usePointerType } from "./hooks/usePointerType";
import { useProjectBootstrap } from "./hooks/useProjectBootstrap";
import { useDawKeymapListener } from "./keymap/listener";
import { ModelsSheet } from "./models";
import { HostRoomProvider } from "./record/hostRoomContext";
import { useRecordHostStore } from "./record/hostStore";
import { sendRecordHostCommand } from "./record/hostWire";
import { useRecordMonitor } from "./record/monitor/useRecordMonitor";
import { useHostKeeperCapture } from "./record/useHostKeeperCapture";
import { useHostRoom } from "./record/useHostRoom";
import { useOutputDevice } from "./record/useOutputDevice";
import { isShareProjectKey } from "./shareMode";
import { CommandPalette } from "./stage/dialogs/CommandPalette";
import { HostMcpDialog } from "./stage/dialogs/HostMcpDialog";
import { EDIT_SHEETS } from "./stage/edit/editSheets";
import { StageFrame } from "./stage/frame/StageFrame";
import { useLandingStage } from "./stage/frame/useLandingStage";
import { BounceFlowProvider } from "./stage/hosts/bounceFlow";
import { ExportFlowProvider } from "./stage/hosts/exportFlow";
import { FindMoreFlowProvider } from "./stage/hosts/findMoreFlow";
import { StageHost } from "./stage/hosts/StageHost";
import { ShareFlowProvider } from "./stage/hosts/shareFlow";
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
  "setModelsSheetOpen",
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
    setModelsSheetOpen,
  } = useDaw(selectDawAppFields);
  const hostMcpDialogOpen = useDaw((s) => s.chrome.hostMcpDialogOpen);
  const helpDialogOpen = useDaw((s) => s.chrome.helpDialogOpen);
  const helpDialogStep = useDaw((s) => s.chrome.helpDialogStep);
  const modelsSheetOpen = useDaw((s) => s.chrome.modelsSheetOpen);
  const { hasProject, projectName, suppressPublish } =
    useDaw(selectDawAppDerived);
  const publishKey = useDawStore(selectPublishKey);

  const {
    error: bootstrapError,
    retrying: bootstrapRetrying,
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
  const hostOutput = useOutputDevice(hostMonitor);
  const setHostPeerLevels = useRecordHostStore((s) => s.setPeerLevels);
  useEffect(() => {
    setHostPeerLevels(hostMonitor.levels);
  }, [hostMonitor.levels, setHostPeerLevels]);

  const recordStageActive = useDawStore((s) => s.stage === "record");
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
      devices: hostKeeper.devices,
      deviceId: hostKeeper.deviceId,
      staleMic: hostKeeper.staleMic,
      onDeviceChange: hostKeeper.setDeviceId,
      output: hostOutput,
    },
    { hydrate: syncEnabled && recordStageActive },
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

  const loadFailure = bootstrapError
    ? { message: bootstrapError, onRetry: retryBootstrap }
    : bootstrapRetrying
      ? {
          message: "Trying again…",
          onRetry: retryBootstrap,
          recovering: true,
        }
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
        <BounceFlowProvider>
          <FindMoreFlowProvider>
            <ShareFlowProvider>
              {engines}
              <div data-daw-app-chrome>
                <StageFrame guestShare={guestShare} sheets={EDIT_SHEETS}>
                  {(viewAnchor) => (
                    <>
                      <StageHost
                        viewAnchor={viewAnchor}
                        guestShare={guestShare}
                        loadFailure={loadFailure}
                        onRetryLoad={retryBootstrap}
                      />
                    </>
                  )}
                </StageFrame>
              </div>
              <CommandPalette />
              <HostMcpDialog
                open={hostMcpDialogOpen}
                onClose={() => setHostMcpDialogOpen(false)}
                hasProject={hasProject}
              />
              <HelpDialog
                open={helpDialogOpen}
                initialStep={helpDialogStep}
                onClose={() => setHelpDialogOpen(false)}
                onOpenShortcuts={() => {
                  setHelpDialogOpen(false);
                  useDawStore.getState().setCommandPaletteOpen(true);
                }}
                onOpenGuides={openGuides}
              />
              {syncEnabled ? (
                <ModelsSheet
                  open={modelsSheetOpen}
                  onClose={() => setModelsSheetOpen(false)}
                />
              ) : null}
              <FeedbackToast />
            </ShareFlowProvider>
          </FindMoreFlowProvider>
        </BounceFlowProvider>
      </ExportFlowProvider>
    </HostRoomProvider>
  );
}
