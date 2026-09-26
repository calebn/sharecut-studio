import { useDawStore } from "../state/dawStore";
import type { DawTab, MobileMode, MoreDestination } from "../state/types";
import { discreteZoomFactor } from "../utils/zoom";
import { registerCommand } from "./execute";

function formatAmp(amp: number): string {
  const rounded = Math.round(amp * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}
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

  const TABS = new Set<DawTab>([
    "transcript",
    "history",
    "impact",
    "tighten",
    "pipeline",
    "comments",
  ]);
  registerCommand("view.setTab", (args) => {
    const tab = args.tab;
    if (typeof tab !== "string" || !TABS.has(tab as DawTab)) {
      return { status: "disabled", reason: "tab required" };
    }
    useDawStore.getState().setActiveTab(tab as DawTab);
    return { status: "ok" };
  });

  const MODES = new Set<MobileMode>(["listen", "timeline", "text", "more"]);
  const DESTINATIONS = new Set<MoreDestination>([
    "hub",
    "comments",
    "history",
    "impact",
    "tighten",
    "pipeline",
  ]);
  registerCommand("view.setMobileMode", (args) => {
    const mode = args.mode;
    if (typeof mode !== "string" || !MODES.has(mode as MobileMode)) {
      return { status: "disabled", reason: "mode required" };
    }
    const dest = args.destination;
    if (typeof dest === "string") {
      if (!DESTINATIONS.has(dest as MoreDestination)) {
        return { status: "disabled", reason: "destination unknown" };
      }
      useDawStore.getState().setMoreDestination(dest as MoreDestination);
    } else {
      useDawStore.getState().setMobileMode(mode as MobileMode);
    }
    return { status: "ok" };
  });

  registerCommand("view.waveformZoomIn", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.nudgeWaveformAmp("in");
    const amp = useDawStore.getState().waveformAmpZoom;
    s.announceStatus(`Waveform amplitude ×${formatAmp(amp)}`);
    return { status: "ok" };
  });

  registerCommand("view.waveformZoomOut", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.nudgeWaveformAmp("out");
    const amp = useDawStore.getState().waveformAmpZoom;
    s.announceStatus(`Waveform amplitude ×${formatAmp(amp)}`);
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

export function registerViewFocusCommands(): void {
  registerCommand("view.focusEditBoundary", () => ({ status: "ok" }));
  registerCommand("view.focusCutAwayWord", () => ({ status: "ok" }));
}

export function registerPaletteCommands(): void {
  registerCommand("ui.toggleCommandPalette", () => {
    useDawStore.getState().toggleCommandPalette();
    return { status: "ok" };
  });
}
