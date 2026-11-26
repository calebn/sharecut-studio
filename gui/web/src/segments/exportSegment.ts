import { downloadSegmentFile } from "../api";
import { type ExportOutcome, shareOrSave } from "../share/shareOrSave";

export type { ExportOutcome };

/** Hands the segment file to the person: the share sheet on a phone, else a download. */
export async function exportSegmentFile(id: string): Promise<ExportOutcome> {
  return shareOrSave(await downloadSegmentFile(id));
}
