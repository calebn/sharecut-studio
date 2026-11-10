import {
  hostLandRecord,
  jobFailure,
  listHostShares,
  loadHostRecordState,
  startRenderPreview,
  waitForPipelineJob,
} from "../api";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { resolveSelectionRange } from "../edit/rangeSelection";
import {
  FEATURE_SHARE_UI_MENU,
  hasFeature,
  peekCachedFeatures,
} from "../extensions/features";
import {
  activeGuestLink,
  copyText,
  createRecordRoomAndCopyGuestLink,
  HOST_COMMENT_QUEUE_TOKEN,
  landGate,
  liveTakeOpen,
  MARKER_BODY,
  postLiveComment,
  STALE_ROOM_LINKS_WARNING,
  sendRecordHostCommand,
  submitHostRecordTransport,
  useRecordHostStore,
} from "../record";
import { canManageProjects, canRefreshMix } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { type RoomKeyHandlers, roomKeys } from "../state/roomKeys";
import { seedStudioJob } from "../state/seedStudioJob";
import { isRangeSelection } from "../state/selection";
import { errorMessage } from "../utils/apiError";
import { type CommandContext, evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import { runRangeAction } from "./rangeActions";
import type { ExecuteResult } from "./types";

const GUIDES_URL = "https://docs.sharecut.studio/";

/** Same rule and reason as the `hostProjectLoaded` when-clause (handlers run with skipWhen). */
export function hostProjectGate(ctx: CommandContext): ExecuteResult | null {
  const gate = evaluateWhen("hostProjectLoaded", ctx);
  return gate.ok ? null : { status: "disabled", reason: gate.reason };
}
/** Share and record rooms live in the collaboration extension; absent until features load says so. */
function shareFeatureGate(what: string): ExecuteResult | null {
  const features = peekCachedFeatures();
  if (features !== null && !hasFeature(features, FEATURE_SHARE_UI_MENU)) {
    return {
      status: "disabled",
      reason: `${what} requires the online extension`,
    };
  }
  return null;
}

/**
 * Keep a failed record command visible. On the Record stage the room's alert
 * slot shows it, so it is not announced again. Elsewhere it is announced and
 * stored for the stage.
 */
function revealRecordFailure(reason: string): boolean {
  const daw = useDawStore.getState();
  if (daw.stage === "record") {
    useRecordHostStore.getState().setTransportError(reason);
    return false;
  }
  daw.announceStatus(reason, { tone: "error" });
  useRecordHostStore.getState().setTransportError(reason);
  return true;
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
    const told = revealRecordFailure(reason);
    return { status: "disabled", reason, ...(told ? { told: true } : {}) };
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
  registerCommand("render.refreshMix", async (args) => {
    // The automatic rebuild (useAutoRefreshMix) stays quiet unless it fails.
    const quiet = args.auto === true;
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
    if (!quiet) {
      s.announceStatus("Refreshing mix preview…");
    }
    try {
      const started = await startRenderPreview(s.projectPath);
      if (!isCurrentProject()) {
        return {
          status: "disabled",
          reason: "Project changed during refresh",
          told: true,
        };
      }
      if (started.mode === "job") {
        seedStudioJob(started.job);
        const done = await waitForPipelineJob(started.job.id);
        if (done.status === "error") {
          seedStudioJob(done);
          const reason = jobFailure(done, "Render preview failed").message;
          if (isCurrentProject()) {
            useDawStore
              .getState()
              .announceStatus(`Refresh failed: ${reason}`, { tone: "error" });
          }
          return {
            status: "disabled",
            reason,
            told: true,
          };
        }
      } else if (!started.ok) {
        const reason = "Render preview failed";
        if (isCurrentProject()) {
          useDawStore
            .getState()
            .announceStatus(`Refresh failed: ${reason}`, { tone: "error" });
        }
        return { status: "disabled", reason, told: true };
      }
      if (!isCurrentProject()) {
        return {
          status: "disabled",
          reason: "Project changed during refresh",
          told: true,
        };
      }
      await refreshDocumentProject(s.projectPath);
      if (!isCurrentProject()) {
        return {
          status: "disabled",
          reason: "Project changed during refresh",
          told: true,
        };
      }
      const store = useDawStore.getState();
      store.setHighlightStaleRender(false);
      if (!quiet) {
        store.announceStatus("Mix preview refreshed");
      }
      return { status: "ok" };
    } catch (err) {
      const reason = errorMessage(err);
      if (isCurrentProject()) {
        useDawStore
          .getState()
          .announceStatus(`Refresh failed: ${reason}`, { tone: "error" });
      }
      return {
        status: "disabled",
        reason,
        told: true,
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
    const s = useDawStore.getState();
    s.setBounceRangeTarget(null);
    s.openStage("deliver");
    s.setBounceRequested(true);
    return { status: "ok" };
  });

  registerCommand("export.transcript", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    const s = useDawStore.getState();
    s.openStage("deliver");
    s.setTranscriptRequested(true);
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

  registerCommand("help.guides", () => {
    window.open(GUIDES_URL, "_blank", "noopener,noreferrer");
    return { status: "ok" };
  });

  registerCommand("models.open", () => {
    const s = useDawStore.getState();
    if (!canManageProjects(s.projectPath)) {
      return { status: "disabled", reason: "Manage models is host-only" };
    }
    s.setModelsSheetOpen(true);
    return { status: "ok" };
  });

  registerCommand("share.manage", (args, ctx) => {
    const blocked = hostProjectGate(ctx) ?? shareFeatureGate("Invite");
    if (blocked) {
      return blocked;
    }
    const at = args.at;
    useDawStore
      .getState()
      .openInvite(at === "record" || at === "listen" ? at : undefined);
    return { status: "ok" };
  });

  registerCommand("record.createRoom", (_args, ctx) => {
    const blocked = hostProjectGate(ctx) ?? shareFeatureGate("Record rooms");
    if (blocked) {
      return blocked;
    }
    if (useRecordHostStore.getState().snapshot) {
      return {
        status: "disabled",
        reason: "A record room is already open. End it in Invite first.",
      };
    }
    const s = useDawStore.getState();
    return runRecordCommand(async () => {
      const { copied, room } = await createRecordRoomAndCopyGuestLink(
        s.projectPath,
      );
      const snap = await loadHostRecordState(s.projectPath);
      if (snap) {
        useRecordHostStore.getState().setSnapshot(snap);
      }
      const base = copied
        ? "Record room created and guest link copied"
        : "Record room created";
      if (room.linksStale) {
        s.announceStatus(`${base}. ${STALE_ROOM_LINKS_WARNING}`, {
          tone: "error",
        });
      } else {
        s.announceStatus(base);
      }
      return { status: "ok" };
    });
  });

  registerCommand("record.copyGuestLink", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    const snap = useRecordHostStore.getState().snapshot;
    if (!snap) {
      return { status: "disabled", reason: "Create a record room first." };
    }
    const s = useDawStore.getState();
    return runRecordCommand(async () => {
      const { shares } = await listHostShares(s.projectPath);
      const url = activeGuestLink(shares, snap.session_id);
      if (!url) {
        throw new Error(
          "This room's guest link is closed. Replace the guest invite in Invite.",
        );
      }
      await copyText(url);
      s.announceStatus("Guest link copied");
      return { status: "ok" };
    });
  });

  registerCommand("record.start", () => runRecordTransportCommand("Start"));
  registerCommand("record.roomTone", () =>
    runRecordCommand(async () => {
      await submitHostRecordTransport("RoomToneCountdown");
      useDawStore.getState().announceStatus("Room tone started. Quiet please.");
      return { status: "ok" };
    }),
  );
  registerCommand("record.setTarget", (args) =>
    runRecordCommand(async () => {
      await submitHostRecordTransport("SetTarget", {
        target: args.target ?? { kind: "end" },
      });
      return { status: "ok" };
    }),
  );
  registerCommand("record.pause", () => runRecordTransportCommand("Pause"));
  registerCommand("record.resume", () => runRecordTransportCommand("Resume"));
  registerCommand("record.stop", () => runRecordTransportCommand("Stop"));
  registerCommand("record.land", () => {
    const s = useDawStore.getState();
    if (!canManageProjects(s.projectPath)) {
      return { status: "disabled", reason: "Landing recordings is host-only" };
    }
    const snap = useRecordHostStore.getState().snapshot;
    const gate = snap ? landGate(snap) : null;
    if (gate && !gate.enabled) {
      return { status: "disabled", reason: gate.reason };
    }
    return runRecordCommand(async () => {
      const result = await hostLandRecord(s.projectPath);
      const n = Array.isArray(result.clips) ? result.clips.length : 0;
      await refreshDocumentProject(s.projectPath);
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

  const roomKey =
    (pick: (k: RoomKeyHandlers) => (() => void) | undefined) =>
    (): ExecuteResult => {
      const k = roomKeys();
      const run = k ? pick(k) : undefined;
      if (!run) return { status: "disabled", reason: "Not available here" };
      run();
      return { status: "ok" };
    };
  registerCommand(
    "room.mute",
    roomKey((k) => k.mute),
  );
  registerCommand(
    "room.take",
    roomKey((k) => k.start),
  );
  registerCommand(
    "room.stop",
    roomKey((k) => k.stop),
  );
  registerCommand(
    "room.pause",
    roomKey((k) => k.pause),
  );

  registerCommand("export.deliverables", (_args, ctx) => {
    const blocked = hostProjectGate(ctx);
    if (blocked) {
      return blocked;
    }
    const s = useDawStore.getState();
    if (s.stage !== "deliver" && isRangeSelection(s.selection)) {
      const resolved = s.project
        ? resolveSelectionRange(s.project, s.selection)
        : null;
      if (resolved?.targets.length === 1) {
        return runRangeAction("bounce");
      }
      const reason = resolved?.reason ?? "Choose the audible occurrence";
      return { status: "disabled", reason };
    }
    s.openStage("deliver");
    s.setExportRequested(true);
    return { status: "ok" };
  });
}
