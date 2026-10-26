/**
 * Per-browser stage conveniences: the stage last used in each project and the
 * Script pane state. Not project state (see `docs/persistence.md`).
 */
import { STAGE_IDS, type StageId } from "../types/stage";
import { readLocal, removeLocal, writeLocal } from "./storage";

const LAST_STAGE_PREFIX = "sharecut.lastStage:";
export const SCRIPT_COLLAPSED_STORAGE_KEY = "sharecut.scriptCollapsed";
export const SCRIPT_FOCUS_STORAGE_KEY = "sharecut.scriptFocus";

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
