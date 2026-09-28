import {
  hostLandRecord,
  refreshProject,
  startExportJob,
  startRenderPreview,
  waitForPipelineJob,
} from "../api";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  FEATURE_SHARE_UI_MENU,
  hasFeature,
  peekCachedFeatures,
} from "../extensions/features";
import { useRecordHostStore } from "../record/hostStore";
import { submitHostRecordTransport } from "../record/hostTransport";
import { sendRecordHostCommand } from "../record/hostWire";
import {
  HOST_COMMENT_QUEUE_TOKEN,
  liveTakeOpen,
  MARKER_BODY,
  postLiveComment,
} from "../record/liveCommentQueue";
import { canManageProjects, canRefreshMix } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { runAnnouncedJob } from "../state/runAnnouncedJob";
import { seedStudioJob } from "../state/seedStudioJob";
import { errorMessage } from "../utils/apiError";
import { type CommandContext, evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

let exportDeliverablesInFlight = false;
export function _resetExportDeliverablesInFlightForTests(): void {
  exportDeliverablesInFlight = false;
}
/** Same rule and reason as the `hostProjectLoaded` when-clause (handlers run with skipWhen). */
export function hostProjectGate(ctx: CommandContext): ExecuteResult | null {
  const gate = evaluateWhen("hostProjectLoaded", ctx);
  return gate.ok ? null : { status: "disabled", reason: gate.reason };
}
/**
 * Keep a failed record command visible. An open Record room panel shows it in its
 * aria-live region, so it is not announced again. Otherwise it is announced, then
 * stored and the panel opens; over the Share dialog it is only announced, so no
 * stale error waits in the store for the next time the panel opens.
 */
function revealRecordFailure(reason: string): void {
  const daw = useDawStore.getState();
  if (daw.recordPanelOpen) {
    useRecordHostStore.getState().setTransportError(reason);
    return;
  }
  daw.announceStatus(reason);
  if (daw.shareDialogOpen) {
    return;
  }
  useRecordHostStore.getState().setTransportError(reason);
  daw.setRecordPanelOpen(true);
}

/** One error path for every record command: clear, run, reveal a failure. */
async function runRecordCommand(
  run: () => Promise<ExecuteResult>,
): Promise<ExecuteResult> {
  useRecordHostStore.getState().setTransportError(null);
  try {
    return await run();
  } catch (err) {
    const reason = errorMessage(err);
    revealRecordFailure(reason);
    return { status: "disabled", reason };
  }
}

function runRecordTransportCommand(
  commandType: string,
): Promise<ExecuteResult> {
  return runRecordCommand(async () => {
    await submitHostRecordTransport(commandType);
    return { status: "ok" };
  });
}
export function registerHostCommands(): void {
  registerCommand("render.refreshMix", async () => {
    const s = useDawStore.getState();
    if (
      !canRefreshMix(s.projectPath, s.guestMode, s.shareCapabilities) ||
      !s.project
    ) {
      return { status: "disabled", reason: "Refresh mix not allowed" };
    }
    if (s.renderPreviewBusy) {
      return { status: "disabled", reason: "Refresh already running" };
    }
    const projectEpoch = s.projectEpoch;
    const isCurrentProject = () =>
      useDawStore.getState().projectEpoch === projectEpoch;
    s.setRenderPreviewBusy(true);
    s.announceStatus("Refreshing mix preview…");
    try {
      const started = await startRenderPreview(s.projectPath);
      if (!isCurrentProject()) {
        return { status: "disabled", reason: "Project changed during refresh" };
      }
      if (started.mode === "job") {
        seedStudioJob(started.job);
        const done = await waitForPipelineJob(started.job.id);
        if (done.status === "error") {
          const reason = done.error ?? "Render preview failed";
          if (isCurrentProject()) {
            useDawStore.getState().announceStatus(`Refresh failed: ${reason}`);
          }
          return {
            status: "disabled",
            reason,
          };
        }
      } else if (!started.ok) {
        const reason = "Render preview failed";
        if (isCurrentProject()) {
          useDawStore.getState().announceStatus(`Refresh failed: ${reason}`);
        }
        return { status: "disabled", reason };
      }
      if (!isCurrentProject()) {
        return { status: "disabled", reason: "Project changed during refresh" };
      }
      const project = await refreshProject(s.projectPath);
      if (!isCurrentProject()) {
        return { status: "disabled", reason: "Project changed during refresh" };
      }
      applyDocumentSnapshot({ project }, { force: true });
      const store = useDawStore.getState();
      store.setHighlightStaleRender(false);
      store.announceStatus("Mix preview refreshed");
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      if (isCurrentProject()) {
        useDawStore.getState().announceStatus(`Refresh failed: ${reason}`);
      }
      return {
        status: "disabled",
        reason,
      };
    } finally {
      if (isCurrentProject()) {
        useDawStore.getState().setRenderPreviewBusy(false);
        useDawStore.getState().setHighlightStaleRender(false);
      }
    }
  });

  registerCommand("export.bounce", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    useDawStore.getState().setBounceDialogOpen(true);
    return { status: "ok" };
  });

  registerCommand("mcp.connect", () => {
    const s = useDawStore.getState();
    if (!canManageProjects(s.projectPath)) {
      return { status: "disabled", reason: "Connect agent is host-only" };
    }
    s.setHostMcpDialogOpen(true);
    return { status: "ok" };
  });

  registerCommand("help.diagnosticsBundle", () => {
    const s = useDawStore.getState();
    if (!canManageProjects(s.projectPath)) {
      return {
        status: "disabled",
        reason: "Export diagnostics is host-only",
      };
    }
    s.setHelpDialogOpen(true);
    return { status: "ok" };
  });

  registerCommand("share.manage", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    const s = useDawStore.getState();
    const features = peekCachedFeatures();
    if (features !== null && !hasFeature(features, FEATURE_SHARE_UI_MENU)) {
      return {
        status: "disabled",
        reason: "Share requires the online extension",
      };
    }
    s.setShareDialogOpen(true);
    return { status: "ok" };
  });

  registerCommand("record.openPanel", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    useDawStore.getState().setRecordPanelOpen(true);
    return { status: "ok" };
  });

  registerCommand("record.start", () => runRecordTransportCommand("Start"));
  registerCommand("record.pause", () => runRecordTransportCommand("Pause"));
  registerCommand("record.resume", () => runRecordTransportCommand("Resume"));
  registerCommand("record.stop", () => runRecordTransportCommand("Stop"));
  registerCommand("record.land", () => {
    const s = useDawStore.getState();
    if (!canManageProjects(s.projectPath)) {
      return { status: "disabled", reason: "Landing keepers is host-only" };
    }
    return runRecordCommand(async () => {
      const result = await hostLandRecord(s.projectPath);
      const n = Array.isArray(result.clips) ? result.clips.length : 0;
      const project = await refreshProject(s.projectPath);
      applyDocumentSnapshot({ project }, { force: true });
      useDawStore
        .getState()
        .announceStatus(`Landed ${n} clip(s) on the timeline`);
      return { status: "ok" };
    });
  });

  registerCommand("record.marker", () => {
    const snap = useRecordHostStore.getState().snapshot;
    if (!snap || !liveTakeOpen(snap.state)) {
      return { status: "disabled", reason: "Record a take to drop a marker" };
    }
    postLiveComment(sendRecordHostCommand, HOST_COMMENT_QUEUE_TOKEN, {
      body: MARKER_BODY,
      takeIndex: snap.take_index,
      recordingMs: snap.recording_ms ?? 0,
      author: "p_host",
    });
    useDawStore.getState().announceStatus("Marker");
    return { status: "ok" };
  });

  registerCommand("export.deliverables", async (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    const s = useDawStore.getState();
    if (exportDeliverablesInFlight) {
      s.announceStatus("Export already in progress…");
      return { status: "disabled", reason: "Export already running" };
    }
    exportDeliverablesInFlight = true;
    s.announceStatus("Exporting deliverables…");
    try {
      await runAnnouncedJob(() => startExportJob(s.projectPath), {
        failLabel: "Export failed",
        resultCopy: (paths) => `Exported ${paths.length} file(s) to export/`,
      });
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      useDawStore.getState().announceStatus(`Export failed: ${reason}`);
      return { status: "disabled", reason };
    } finally {
      exportDeliverablesInFlight = false;
    }
  });
}
