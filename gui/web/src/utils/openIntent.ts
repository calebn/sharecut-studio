/**
 * What Home asked of the project it is about to open: the stage a card named,
 * and whether to start processing the audio Home just imported. One-shot and
 * per tab (`sessionStorage`), keyed by project path: the studio takes each part
 * once after the project loads, so a reload or a later open never replays it.
 * Not project state (see `docs/persistence.md`).
 */
import { STAGE_IDS, type StageId } from "../types/stage";

const PREFIX = "sharecut.openIntent:";

export type OpenIntent = { stage?: StageId; autoRun?: boolean };

function read(projectPath: string): OpenIntent {
  try {
    const raw = globalThis.sessionStorage?.getItem(PREFIX + projectPath);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const { stage, autoRun } = parsed as Record<string, unknown>;
    return {
      stage: STAGE_IDS.find((id) => id === stage),
      autoRun: autoRun === true ? true : undefined,
    };
  } catch {
    return {};
  }
}

function write(projectPath: string, intent: OpenIntent): void {
  try {
    const empty = intent.stage === undefined && !intent.autoRun;
    if (empty) globalThis.sessionStorage?.removeItem(PREFIX + projectPath);
    else
      globalThis.sessionStorage?.setItem(
        PREFIX + projectPath,
        JSON.stringify(intent),
      );
  } catch {
    /* blocked storage: the project opens on its landing stage */
  }
}

export function writeOpenIntent(projectPath: string, intent: OpenIntent): void {
  if (projectPath) write(projectPath, intent);
}

/** The stage Home named, removed so it applies once. */
export function takeOpenStage(projectPath: string): StageId | null {
  const intent = read(projectPath);
  if (intent.stage === undefined) return null;
  write(projectPath, { autoRun: intent.autoRun });
  return intent.stage;
}

/** True once when Home imported audio into this project and wants it processed. */
export function takeAutoRun(projectPath: string): boolean {
  const intent = read(projectPath);
  if (!intent.autoRun) return false;
  write(projectPath, { stage: intent.stage });
  return true;
}
