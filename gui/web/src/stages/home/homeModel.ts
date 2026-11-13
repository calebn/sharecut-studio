import type { RecentProject } from "../../api";
import {
  formatBytes,
  type ModelView,
  unsupportedSentence,
  type useModels,
} from "../../models";
import type { ProjectCardData } from "../../system/ProjectCard";
import { STATUS_TEXT } from "../../system/statusText";
import { plural } from "../../utils/format";
import { dayMonth, relativeTime } from "../../utils/relativeTime";
import type { SetupData } from "./HomeView";

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pair = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pair(m)}:${pair(s)}` : `${m}:${pair(s)}`;
}

export function formatEdited(editedAt: string | null, now: Date): string {
  const ago = relativeTime(editedAt, now);
  if (!ago) return "";
  return ago === "just now" ? "edited just now" : `edited ${ago}`;
}

const STATE_OF = new Set<string>(Object.keys(STATUS_TEXT));

function chipState(state: string): ProjectCardData["chip"]["state"] {
  return STATE_OF.has(state)
    ? (state as ProjectCardData["chip"]["state"])
    : "not-yet";
}

/** One recent entry as the card Home draws; the card's id is the project file's path. */
export function cardOf(project: RecentProject, now: Date): ProjectCardData {
  const meta = [
    project.duration_sec == null ? "" : formatDuration(project.duration_sec),
    formatEdited(project.edited_at, now),
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: project.path,
    name: project.name,
    meta,
    stage: project.stage,
    chip: { text: project.chip.text, state: chipState(project.chip.state) },
    peaks: project.peaks,
    folderMissing: project.folder_missing || undefined,
  };
}

export function cardsOf(
  projects: readonly RecentProject[],
  now: Date,
): ProjectCardData[] {
  return projects.map((project) => cardOf(project, now));
}

// The names Windows keeps for devices; the server refuses them for a typed name
// (recent_projects._WINDOWS_RESERVED), so a name taken from a file falls back instead.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function episodeNameFromFiles(
  files: readonly { name: string }[],
  now: Date,
): string {
  if (files.length > 1) return `Episode, ${dayMonth(now)}`;
  const base = (files[0]?.name ?? "").replace(/\.[^./\\]+$/, "").trim();
  const reserved = RESERVED_NAME.test(base.split(".", 1)[0] ?? "");
  return base && !reserved ? base : `Episode, ${dayMonth(now)}`;
}

export function untitledEpisodeName(now: Date): string {
  return `Untitled episode · ${dayMonth(now)}`;
}

export function importingLine(count: number): string {
  return `Importing ${count} ${plural(count, "file")}…`;
}

export type ImportStop = {
  reason: string;
  added: number;
  total: number;
  name: string;
  projectPath: string;
};

/** What a stopped Import left on disk: the episode stays listed, so say what is in it and where. */
export function importStoppedLine(stop: ImportStop): string {
  const reason = /[.!?]$/.test(stop.reason) ? stop.reason : `${stop.reason}.`;
  const folder = stop.projectPath.replace(/[\\/][^\\/]*$/, "");
  if (stop.added === 0) {
    return `${reason} Nothing was added. The new episode has no audio yet and is still in Recent. Its folder is ${folder}.`;
  }
  return `${reason} ${stop.added} of ${stop.total} ${plural(stop.total, "file")} were added to "${stop.name}". Open it from Recent to add the rest. Its folder is ${folder}.`;
}

function needsDownload(model: ModelView): boolean {
  const kind = model.state.kind;
  return kind === "missing" || kind === "update_needed" || kind === "failed";
}

/** Get ready's bundle: every model that is not installed (the aligner and speaker model included). */
export function bundleToGet(models: readonly ModelView[] | null): string[] {
  return modelsToGet(models).map((m) => m.id);
}

function modelsToGet(models: readonly ModelView[] | null): ModelView[] {
  return (models ?? []).filter(needsDownload);
}

function sizeLabelOf(models: readonly ModelView[]): string {
  const sizes = models.map((m) => m.sizeBytes);
  if (sizes.length === 0 || sizes.some((s) => s === null)) {
    return "a few gigabytes";
  }
  const total = sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0);
  if (total >= 1_000_000_000) {
    return `about ${Math.round(total / 100_000_000) / 10} GB`;
  }
  return `about ${Math.max(1, Math.round(total / 1_000_000))} MB`;
}

/** True once a status has arrived and says the audio tools are not there, though this device could have them. */
export function toolsMissing(
  api: Pick<ReturnType<typeof useModels>, "models" | "tools">,
): boolean {
  return (
    api.models !== null &&
    api.tools.ffmpeg !== "installed" &&
    api.tools.ffmpeg !== "unsupported"
  );
}

/** The server's sentence once a status says this device cannot have audio tools, else null. */
export function toolsUnsupportedSentence(
  api: Pick<ReturnType<typeof useModels>, "models" | "tools">,
): string | null {
  return api.models !== null && api.tools.ffmpeg === "unsupported"
    ? unsupportedSentence(api.tools.hint)
    : null;
}

function isRunning(model: ModelView): boolean {
  return model.state.kind === "downloading" || model.state.kind === "queued";
}

export type DownloadTotals = {
  bytes: number;
  total: number | null;
  failedRows?: string;
};

export function downloadTotals(
  models: readonly ModelView[] | null,
): DownloadTotals | null {
  const running = (models ?? []).filter(isRunning);
  if (running.length === 0) return null;
  const current = running.findIndex((m) => m.state.kind === "downloading");
  let bytes = 0;
  let total = 0;
  let known = true;
  running.forEach((m, i) => {
    if (m.state.kind === "downloading") {
      bytes += m.state.bytes;
      if (m.state.total === null) known = false;
      else total += m.state.total;
    } else if (m.sizeBytes === null) known = false;
    else {
      total += m.sizeBytes;
      if (i < current) bytes += m.sizeBytes;
    }
  });
  const failedRows = models
    ?.filter((model) => model.state.kind === "failed")
    .map((model) => `${model.id}/${model.variant ?? ""}`)
    .sort()
    .join(",");
  return {
    bytes,
    total: known && total > 0 ? total : null,
    ...(failedRows ? { failedRows } : {}),
  };
}

export function holdTotals(
  held: DownloadTotals | null,
  next: DownloadTotals | null,
): DownloadTotals | null {
  if (held === null || next === null || held.failedRows !== next.failedRows) {
    return next;
  }
  return {
    ...next,
    bytes: Math.max(held.bytes, next.bytes),
    total:
      held.total === null || next.total === null
        ? next.total
        : Math.max(held.total, next.total),
  };
}

/** "about 3 min", "about 1 h 5 min", or "less than a minute" for the last stretch. */
export function timeLeftText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (seconds < 45) return "less than a minute";
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} h` : `about ${hours} h ${rest} min`;
}

/**
 * The Setup card's state from the models provider, or null when nothing is
 * needed. While the first status is on its way the state is `checking` (the
 * card draws nothing for its first 300 ms). Missing audio tools are their own
 * state with nothing to download. `secondsLeft` is the caller's estimate for a
 * running download, appended to the bytes line. `totals` is the download's
 * progress; the caller passes it when it holds it steady across frames.
 */
export function setupOf(
  api: Pick<
    ReturnType<typeof useModels>,
    "models" | "downloads" | "tools" | "ready" | "loadError"
  >,
  secondsLeft: number | null = null,
  totals: DownloadTotals | null = downloadTotals(api.downloads),
): SetupData | null {
  const { models, ready, loadError } = api;
  if (models === null) {
    return { state: loadError ? "check-error" : "checking", sizeLabel: "" };
  }
  if (totals) {
    const { bytes, total } = totals;
    const left = secondsLeft === null ? "" : ` · ${timeLeftText(secondsLeft)}`;
    return {
      state: "downloading",
      sizeLabel: sizeLabelOf(api.downloads.filter(isRunning)),
      progress: total === null ? undefined : Math.min(1, bytes / total),
      detail:
        total === null
          ? `${formatBytes(bytes)} downloaded`
          : `${formatBytes(bytes)} of ${formatBytes(total)}${left}`,
    };
  }
  if (models.some((model) => model.state.kind === "unavailable")) {
    return { state: "check-error", sizeLabel: "" };
  }
  if (models.some((model) => model.state.kind === "checking")) {
    return { state: "checking", sizeLabel: "" };
  }
  const unsupported = toolsUnsupportedSentence(api);
  if (unsupported !== null) {
    return { state: "tools-unsupported", sizeLabel: "", detail: unsupported };
  }
  if (toolsMissing(api)) return { state: "tools-missing", sizeLabel: "" };
  if (ready) return null;
  const toGet = modelsToGet(models);
  if (toGet.length === 0) return null;
  const failed = toGet.some((m) => m.state.kind === "failed");
  return {
    state: failed ? "failed" : "needed",
    sizeLabel: sizeLabelOf(toGet),
  };
}
