/**
 * What Home asked of the project it is about to open: the stage a card named,
 * and whether to start processing the audio Home just imported. Edit's empty
 * Script also writes `autoRun` when it hands the episode to Prepare. One-shot and
 * per tab (`sessionStorage`), keyed by project path: the studio takes each part
 * once after the project loads, so a reload or a later open never replays it.
 * Not project state (see `docs/persistence.md`).
 */
import { STAGE_IDS, type StageId } from "../types/stage";

const PREFIX = "sharecut.openIntent:";

export type OpenIntent = {
  stage?: StageId;
  autoRun?: boolean;
  autoRoom?: boolean;
};

function read(projectPath: string): OpenIntent {
  try {
    const raw = globalThis.sessionStorage?.getItem(PREFIX + projectPath);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const { stage, autoRun, autoRoom } = parsed as Record<string, unknown>;
    return {
      stage: STAGE_IDS.find((id) => id === stage),
      autoRun: autoRun === true ? true : undefined,
      autoRoom: autoRoom === true ? true : undefined,
    };
  } catch {
    return {};
  }
}

function write(projectPath: string, intent: OpenIntent): void {
  try {
    const empty =
      intent.stage === undefined && !intent.autoRun && !intent.autoRoom;
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

/** Ask Prepare to start processing on arrival, keeping what else the intent holds. */
export function requestAutoRun(projectPath: string): void {
  if (projectPath) write(projectPath, { ...read(projectPath), autoRun: true });
}

/** The stage Home named, removed so it applies once. */
export function takeOpenStage(projectPath: string): StageId | null {
  const intent = read(projectPath);
  if (intent.stage === undefined) return null;
  write(projectPath, {
    autoRun: intent.autoRun,
    autoRoom: intent.autoRoom,
  });
  return intent.stage;
}

/** True once when Home or Edit's empty Script wants this project's audio processed on arrival. */
export function takeAutoRun(projectPath: string): boolean {
  const intent = read(projectPath);
  if (!intent.autoRun) return false;
  write(projectPath, { stage: intent.stage, autoRoom: intent.autoRoom });
  return true;
}

/** True once when Home sent the host to Record to make its first room. */
export function takeAutoRoom(projectPath: string): boolean {
  const intent = read(projectPath);
  if (!intent.autoRoom) return false;
  write(projectPath, { stage: intent.stage, autoRun: intent.autoRun });
  return true;
}

/** The stage Home named, left in place: the Loading cover draws that stage's layout. */
export function peekOpenStage(projectPath: string): StageId | null {
  return read(projectPath).stage ?? null;
}
