import { canApplyPass12, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { stageRoleOf, stagesForRole } from "../state/stageRoutes";
import {
  REVIEW_SECTIONS,
  type ReviewSection,
  STAGE_IDS,
  STAGE_SHEETS,
  type StageSheet,
} from "../types/stage";
import { discreteZoomFactor, formatWaveformAmp } from "../utils/zoom";
import { registerCommand } from "./execute";

const isReviewSection = (v: unknown): v is ReviewSection =>
  (REVIEW_SECTIONS as readonly unknown[]).includes(v);
const isStageSheet = (v: unknown): v is StageSheet =>
  (STAGE_SHEETS as readonly unknown[]).includes(v);

export function registerViewCommands(): void {
  registerCommand("view.zoomIn", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.applyAnchoredZoom(s.zoomPxPerSec * discreteZoomFactor("in"));
    return { status: "ok" };
  });

  registerCommand("view.zoomOut", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.applyAnchoredZoom(s.zoomPxPerSec * discreteZoomFactor("out"));
    return { status: "ok" };
  });

  registerCommand("view.fit", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.fitToWindow(s.measureTimelineViewport());
    return { status: "ok" };
  });

  for (const stage of STAGE_IDS) {
    registerCommand(`stage.${stage}`, (args) => {
      const s = useDawStore.getState();
      if (!s.project) {
        return { status: "disabled", reason: "No project" };
      }
      if (!stagesForRole(stageRoleOf(s.guestMode)).includes(stage)) {
        return { status: "disabled", reason: "This link cannot open that" };
      }
      const section = args.section;
      const sheet = args.sheet;
      const options = {
        ...(isReviewSection(section) ? { section } : {}),
        ...(isStageSheet(sheet) ? { sheet } : {}),
      };
      if (Object.keys(options).length > 0) s.openStage(stage, options);
      else s.openStage(stage);
      return { status: "ok" };
    });
  }

  registerCommand("edit.history", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "This link cannot edit" };
    }
    s.openStage("edit", { sheet: "history" });
    return { status: "ok" };
  });

  registerCommand("view.toggleScript", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.setScriptCollapsed(!s.scriptCollapsed);
    s.announceStatus(s.scriptCollapsed ? "Script shown" : "Script hidden");
    return { status: "ok" };
  });

  registerCommand("view.scriptFocus", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.setScriptFocus(!s.scriptFocus);
    s.announceStatus(s.scriptFocus ? "Script focus off" : "Script focus on");
    return { status: "ok" };
  });

  registerCommand("view.waveformZoomIn", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.nudgeWaveformAmp("in");
    const amp = useDawStore.getState().waveformAmpZoom;
    s.announceStatus(`Waveform amplitude ×${formatWaveformAmp(amp)}`);
    return { status: "ok" };
  });

  registerCommand("view.waveformZoomOut", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.nudgeWaveformAmp("out");
    const amp = useDawStore.getState().waveformAmpZoom;
    s.announceStatus(`Waveform amplitude ×${formatWaveformAmp(amp)}`);
    return { status: "ok" };
  });

  registerCommand("view.fitTracksHeight", () => {
    const s = useDawStore.getState();
    s.toggleFitTracksHeight();
    const mode = useDawStore.getState().laneHeightMode;
    s.announceStatus(
      mode === "fit" ? "Tracks fit window height" : "Fixed track height",
    );
    return { status: "ok" };
  });

  registerCommand("view.trackHeightIncrease", () => {
    const s = useDawStore.getState();
    s.stepLaneHeight("up");
    const px = useDawStore.getState().laneHeightPx;
    s.announceStatus(`Track height ${px} px`);
    return { status: "ok" };
  });

  registerCommand("view.trackHeightDecrease", () => {
    const s = useDawStore.getState();
    s.stepLaneHeight("down");
    const px = useDawStore.getState().laneHeightPx;
    s.announceStatus(`Track height ${px} px`);
    return { status: "ok" };
  });

  // A volume still in its save delay goes first, so undo takes it back
  // instead of the step before it.
}

export function registerTranscriptViewCommands(): void {
  registerCommand("view.transcriptAnnotate", () => {
    useDawStore.getState().toggleTranscriptAnnotate();
    return { status: "ok" };
  });

  registerCommand("transcript.findReplace", () => {
    const state = useDawStore.getState();
    if (!state.project || isShareProjectKey(state.projectPath))
      return { status: "disabled", reason: "Host project required" };
    state.openStage("edit");
    state.setScriptCollapsed(false);
    useDawStore
      .getState()
      .setTranscriptFindReplaceOpen(!state.chrome.transcriptFindReplaceOpen);
    return { status: "ok" };
  });

  registerCommand("transcript.correctIntent", () => {
    // Intent is owned by TranscriptPanel; store annotate stays independent.
    return { status: "ok" };
  });

  registerCommand("transcript.selectIntent", () => {
    return { status: "ok" };
  });

  registerCommand("view.showCutAway", () => {
    const s = useDawStore.getState();
    if (!s.transcriptAnnotate) {
      s.setTranscriptAnnotate(true);
    }
    s.toggleShowCutAwayUtterances();
    return { status: "ok" };
  });
}

export function registerPaletteCommands(): void {
  registerCommand("ui.toggleCommandPalette", () => {
    useDawStore.getState().toggleCommandPalette();
    return { status: "ok" };
  });
}
