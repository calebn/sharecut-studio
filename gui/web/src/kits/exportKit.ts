import { downloadKitFile } from "../api";
import { type ExportOutcome, shareOrSave } from "../utils/shareOrSave";

/** Hands the kit file to the person: the share sheet on a phone, else a download. */
export async function exportKitFile(
  id: string,
  signal?: AbortSignal,
): Promise<ExportOutcome> {
  return shareOrSave(await downloadKitFile(id, signal));
}
