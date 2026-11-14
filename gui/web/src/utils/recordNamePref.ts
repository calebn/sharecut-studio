import { capCommentName } from "./commentAuthor";
import { readLocal, writeLocal } from "./storage";

const RECORD_NAME_KEY = "sharecut.recordName";

/** The name this device last joined a recording room with, or "". */
export function readRecordName(): string {
  return capCommentName(readLocal(RECORD_NAME_KEY) ?? "");
}

export function writeRecordName(name: string): void {
  const kept = capCommentName(name);
  if (kept) writeLocal(RECORD_NAME_KEY, kept);
}
