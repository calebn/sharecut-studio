import { KIT_EXTENSION, SEGMENT_EXTENSION } from "./classifyBundle";
import { ZIP_TYPE } from "./importCopy";

export const IMPORT_LABEL = "Import";
export const IMPORT_ACCEPT = `${SEGMENT_EXTENSION},${KIT_EXTENSION},${ZIP_TYPE}`;
export const DROP_LABEL = "Drop a segment or kit file to import it";
export const DROP_HINT =
  "Have a segment or kit file? Choose Import, or drop it here.";
export const NOT_A_BUNDLE_FILE = `That isn't a segment or kit file (${SEGMENT_EXTENSION}, ${KIT_EXTENSION}).`;
export const OPEN_FILE_GONE =
  "That file can't be found. Open it from the share sheet again.";
export const OPEN_FILE_FAILED =
  "That file couldn't be opened. Open it from the share sheet again.";
export const OPEN_FILE_TOO_LARGE =
  "That file is too large to open here. Import a smaller one.";
export const ONE_FILE_ONLY = "Import one file at a time.";

/** Whether a dropped or picked file looks like one of ours before its contents are read. */
export function looksLikeBundle(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(SEGMENT_EXTENSION) ||
    name.endsWith(KIT_EXTENSION) ||
    name.endsWith(".zip") ||
    file.type === ZIP_TYPE
  );
}
