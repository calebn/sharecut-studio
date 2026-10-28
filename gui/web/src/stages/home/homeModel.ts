import type { RecentProject } from "../../api";
import { formatBytes, type ModelView, type useModels } from "../../models";
import type { ProjectCardData } from "../../system/ProjectCard";
import { STATUS_TEXT } from "../../system/statusText";
import { plural } from "../../utils/format";
import type { SetupData } from "./HomeView";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function dayMonth(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pair = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pair(m)}:${pair(s)}` : `${m}:${pair(s)}`;
}

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

export function formatEdited(editedAt: string | null, now: Date): string {
  const at = editedAt ? new Date(editedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "edited just now";
  if (minutes < 60) return `edited ${minutes} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days < 1) return `edited ${Math.floor(minutes / 60)} h ago`;
  if (days === 1) return "edited yesterday";
  if (days < 7) return `edited ${days} days ago`;
  if (days < 14) return "edited last week";
  return `edited ${dayMonth(at)}`;
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

export function episodeNameFromFiles(
  files: readonly { name: string }[],
  now: Date,
): string {
  if (files.length > 1) return `Episode, ${dayMonth(now)}`;
  const base = (files[0]?.name ?? "").replace(/\.[^./\\]+$/, "").trim();
  return base || `Episode, ${dayMonth(now)}`;
}

export function untitledEpisodeName(now: Date): string {
  return `Untitled episode · ${dayMonth(now)}`;
}

export function importingLine(count: number): string {
  return `Importing ${count} ${plural(count, "file")}…`;
}

function needsDownload(model: ModelView): boolean {
  const kind = model.state.kind;
  return kind === "missing" || kind === "update_needed" || kind === "failed";
}

export function bundleToGet(models: readonly ModelView[] | null): string[] {
  return (models ?? [])
    .filter((m) => m.tier !== "offered" && needsDownload(m))
    .map((m) => m.id);
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

/**
 * The Setup card's state from the models provider, or null when nothing is
 * needed (or the first status has not arrived: nothing renders while checking).
 * Nothing to download is also null: a missing ffmpeg shows in the Models dialog,
 * not as a download that would do nothing.
 */
export function setupOf(
  api: Pick<ReturnType<typeof useModels>, "models" | "ready" | "loadError">,
): SetupData | null {
  const { models, ready, loadError } = api;
  if (models === null) {
    return loadError ? { state: "check-error", sizeLabel: "" } : null;
  }
  const running = models.filter(
    (m) => m.state.kind === "downloading" || m.state.kind === "queued",
  );
  if (running.length > 0) {
    let bytes = 0;
    let total = 0;
    let known = true;
    for (const m of running) {
      if (m.state.kind === "downloading") {
        bytes += m.state.bytes;
        if (m.state.total === null) known = false;
        else total += m.state.total;
      } else if (m.sizeBytes === null) known = false;
      else total += m.sizeBytes;
    }
    return {
      state: "downloading",
      sizeLabel: sizeLabelOf(running),
      progress: known && total > 0 ? Math.min(1, bytes / total) : undefined,
      detail:
        known && total > 0
          ? `${formatBytes(bytes)} of ${formatBytes(total)}`
          : `${formatBytes(bytes)} downloaded`,
    };
  }
  if (ready) return null;
  const toGet = models.filter((m) => m.tier !== "offered" && needsDownload(m));
  if (toGet.length === 0) return null;
  const failed = toGet.some((m) => m.state.kind === "failed");
  return {
    state: failed ? "failed" : "needed",
    sizeLabel: sizeLabelOf(toGet),
  };
}
