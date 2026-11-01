import { loadPipelineConfig, putPipelineConfig } from "../../api";
import { setByPath } from "../../utils/configPath";
import {
  readSoundScanStart,
  SOUND_SCAN_PATH,
  SOUND_SCAN_STEP,
} from "./soundScan";

/**
 * Gives a project that was just created the person's own start choice for the
 * sound scan. The project keeps its own switch from then on. Never throws: a
 * project that could not be set keeps the saved default.
 */
export async function applySoundScanStart(projectPath: string): Promise<void> {
  try {
    const on = readSoundScanStart();
    const current = await loadPipelineConfig(projectPath);
    const enabled = new Set(current.enabled_steps);
    if (on) enabled.add(SOUND_SCAN_STEP);
    else enabled.delete(SOUND_SCAN_STEP);
    await putPipelineConfig(projectPath, {
      config: setByPath({}, SOUND_SCAN_PATH, on),
      enabled_steps: [...enabled],
    });
  } catch {
    /* the project keeps the saved default; Advanced still changes it */
  }
}
