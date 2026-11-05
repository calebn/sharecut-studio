export const MIN_DESCRIPTION = 10;
export const MAX_DESCRIPTION = 4000;

/** The id characters kept in the reference a person can read out. */
const REFERENCE_CHARS = 8;

export type BundlePreview = {
  filename: string;
  path: string;
  files: readonly string[];
  sizeBytes: number;
  appVersion: string;
};

/** Where a report is, after the person pressed Send report. */
export type ReportPhase =
  | { kind: "editing" }
  | { kind: "sending" }
  | { kind: "sent"; reference: string }
  | { kind: "queued" }
  | { kind: "saved"; path: string; supportHref: string | null }
  | { kind: "failed"; reason: string };

export type PreviewState =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "ready"; bundle: BundlePreview }
  | { kind: "failed"; reason: string };

export const DESCRIBE_FIRST = "Describe the problem first.";
export const INCLUDES_LINE =
  "Includes logs and settings. No audio, transcripts or project files.";
export const PUBLIC_LINE =
  "Sending posts your description and the report publicly. The file link expires after 30 days.";
export const SAVED_LOCALLY = "Saved on this computer.";
export const QUEUED_DETAIL = "It sends when you're online.";

/** The last path segment of the relay's status URL, shortened so it reads aloud. */
export function referenceOf(statusUrl: string): string {
  const id =
    statusUrl.split("?")[0]?.split("/").filter(Boolean).at(-1) ?? statusUrl;
  return `R-${id.slice(0, REFERENCE_CHARS)}`;
}

export function sendBlockedReason(description: string): string | undefined {
  return description.trim().length >= MIN_DESCRIPTION
    ? undefined
    : DESCRIBE_FIRST;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  return kib < 1024 ? `${kib.toFixed(1)} KB` : `${(kib / 1024).toFixed(1)} MB`;
}

/** The support page, pre-filled when it is the project's GitHub issue tracker. */
export function supportLink(
  base: string | null,
  description: string,
  appVersion: string,
): string | null {
  if (!base) return null;
  if (base.includes("github.com/") && base.endsWith("/issues")) {
    return `${base}/new?template=bug_report.yml&what-happened=${encodeURIComponent(description)}&version=${encodeURIComponent(appVersion)}`;
  }
  return base;
}
