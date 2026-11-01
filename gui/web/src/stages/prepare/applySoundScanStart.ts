import { loadPipelineConfig, putPipelineConfig } from "../../api";
import { readLocal, removeLocal, writeLocal } from "../../utils/storage";
import { withStepSwitch } from "./advancedModel";
import { readSoundScanStart, SOUND_SCAN_STEP } from "./soundScan";

/** Set when the start choice could not be saved on a new project; Prepare says so once. */
const FAILED_KEY = "sharecut.soundScanStartFailed";

/**
 * Gives a project that was just created the person's own start choice for the
 * sound scan. The project keeps its own switch from then on.
 *
 * The config PUT replaces the working set with the defaults plus what it is
 * sent (`PipelineConfigStore.put`), so this sends the project's whole current
 * config with the one setting changed, the way every Advanced edit does.
 * Never throws: on failure the project keeps the saved default and the
 * failure is remembered for Prepare to say (`takeSoundScanStartFailure`).
 */
export async function applySoundScanStart(projectPath: string): Promise<void> {
  try {
    const current = await loadPipelineConfig(projectPath);
    await putPipelineConfig(
      projectPath,
      withStepSwitch(current, SOUND_SCAN_STEP, readSoundScanStart()),
    );
  } catch {
    writeLocal(FAILED_KEY, projectPath);
  }
}

/** True once if this project's start choice could not be applied when it was created. */
export function takeSoundScanStartFailure(projectPath: string): boolean {
  if (readLocal(FAILED_KEY) !== projectPath) return false;
  removeLocal(FAILED_KEY);
  return true;
}
