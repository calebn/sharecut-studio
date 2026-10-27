/**
 * Per-browser stage conveniences: the stage last used in each project and the
 * Script pane state. Not project state (see `docs/persistence.md`).
 */
import { STAGE_IDS, type StageId } from "../types/stage";
import { readLocal, removeLocal, writeLocal } from "./storage";

const LAST_STAGE_PREFIX = "sharecut.lastStage:";
const SCRIPT_COLLAPSED_STORAGE_KEY = "sharecut.scriptCollapsed";
const SCRIPT_FOCUS_STORAGE_KEY = "sharecut.scriptFocus";

export function readLastStage(projectPath: string): StageId | null {
  const raw = readLocal(LAST_STAGE_PREFIX + projectPath);
  return STAGE_IDS.find((id) => id === raw) ?? null;
}

export function writeLastStage(projectPath: string, stage: StageId): void {
  if (projectPath) writeLocal(LAST_STAGE_PREFIX + projectPath, stage);
}

function readFlag(key: string): boolean {
  return readLocal(key) === "1";
}

function writeFlag(key: string, on: boolean): void {
  if (on) writeLocal(key, "1");
  else removeLocal(key);
}

export const readScriptCollapsed = () => readFlag(SCRIPT_COLLAPSED_STORAGE_KEY);
export const writeScriptCollapsed = (on: boolean) =>
  writeFlag(SCRIPT_COLLAPSED_STORAGE_KEY, on);
export const readScriptFocus = () => readFlag(SCRIPT_FOCUS_STORAGE_KEY);
export const writeScriptFocus = (on: boolean) =>
  writeFlag(SCRIPT_FOCUS_STORAGE_KEY, on);

const SCRIPT_WIDTH_STORAGE_KEY = "sharecut.scriptWidth";

/** The Script pane's width in rem, or null before the person has dragged it. */
export function readScriptWidth(): number | null {
  const n = Number(readLocal(SCRIPT_WIDTH_STORAGE_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function writeScriptWidth(rem: number | null): void {
  if (rem == null) removeLocal(SCRIPT_WIDTH_STORAGE_KEY);
  else writeLocal(SCRIPT_WIDTH_STORAGE_KEY, rem.toFixed(2));
}
