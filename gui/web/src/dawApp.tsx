import { useEffect } from "react";
import { registerDawWebMcpTools } from "./agentic/webmcp";
import {
  registerDawCommands,
  setBladeCommandRunner,
} from "./commands/register";
import { HelpDialog } from "./home/HelpDialog";
import { useAudioTransport } from "./hooks/useAudioTransport";
import { useBladeCut } from "./hooks/useBladeCut";
import { useDocumentSync } from "./hooks/useDocumentSync";
import { useFollowTransport } from "./hooks/useFollowTransport";
import { useFollowUi } from "./hooks/useFollowUi";
import { useFollowViewport } from "./hooks/useFollowViewport";
import { useGuestSync } from "./hooks/useGuestSync";
import { usePipelineJob } from "./hooks/usePipelineJob";
import { usePointerType } from "./hooks/usePointerType";
import { useProjectBootstrap } from "./hooks/useProjectBootstrap";
import { useProjectPoll } from "./hooks/useProjectPoll";
import { useProxyTransport } from "./hooks/useProxyTransport";
import { useSessionSync } from "./hooks/useSessionSync";
import { useDawKeymapListener } from "./keymap/listener";
import { BounceDialog } from "./layout/BounceDialog";
import { CheatsheetDialogs } from "./layout/CheatsheetDialogs";
import { HostMcpDialog } from "./layout/HostMcpDialog";
import { ShareDialog } from "./layout/ShareDialog";
import { StudioShell } from "./layout/StudioShell";
import { sendRecordHostCommand } from "./record/hostWire";
import { useRecordMonitor } from "./record/monitor/useRecordMonitor";
import { RecordPanel } from "./record/RecordPanel";
import { useHostKeeperCapture } from "./record/useHostKeeperCapture";
import { isShareProjectKey } from "./shareMode";
import { useDaw } from "./state/useDaw";
import { Button, ErrorScreen } from "./ui";

let commandsRegistered = false;

export function DawApp({ guestShare = false }: { guestShare?: boolean }) {
  const {
    project,
    projectPath,
    setProject,
    isPlaying,
    applyAgentSession,
    buildViewerSnapshot,
    suppressPublish,
    lastAppliedRevision,
    lastAppliedCommandId,
    auditionMode,
    selection,
    sessionRegion,
    viewerMute,
    soloTracks,
    pipelineJob,
    setPipelineJob,
    activityJob,
    setActivityJob,
    setActivityRunningCount,
    setSessionClients,
    hostMcpDialogOpen,
    setHostMcpDialogOpen,
    helpDialogOpen,
    setHelpDialogOpen,
  } = useDaw();

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

  const publishKey = JSON.stringify({
    auditionMode,
    selection,
    sessionRegion,
    viewerMute,
    soloTracks,
    isPlaying,
  });

  useProjectPoll(projectPath, setProject);
  useDocumentSync(projectPath, project, setProject, syncEnabled);
  useSessionSync(
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
  useGuestSync(
    projectPath,
    applyAgentSession,
    project,
    setProject,
    setSessionClients,
    guestSyncEnabled,
  );
  useFollowTransport();
  useFollowViewport();
  useFollowUi();
  usePointerType();
  const proxyActive = useProxyTransport();
  useAudioTransport(!proxyActive);

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
    if (!project?.meta.name) {
      return;
    }
    const previous = document.title;
    document.title = project.meta.name;
    return () => {
      document.title = previous;
    };
  }, [project?.meta.name]);

  if (bootstrapError && !project) {
    return <ErrorScreen message={bootstrapError} />;
  }

  return (
    <>
      <div data-daw-app-chrome>
        {bootstrapError && project ? (
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
      <ShareDialog />
      <RecordPanel
        recordingLocally={hostKeeper.recordingLocally}
        keeperError={hostKeeper.error}
        hearing={hostMonitor.hearing}
        monitorError={hostMonitor.error}
        stream={hostKeeper.stream}
      />
      <HostMcpDialog
        open={hostMcpDialogOpen}
        onClose={() => setHostMcpDialogOpen(false)}
        hasProject={Boolean(project)}
      />
      <HelpDialog
        open={helpDialogOpen}
        onClose={() => setHelpDialogOpen(false)}
      />
    </>
  );
}
