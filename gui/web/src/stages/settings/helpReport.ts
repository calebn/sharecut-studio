export const MIN_DESCRIPTION = 10;
export const MAX_DESCRIPTION = 4000;

const REFERENCE_CHARS = 8;

export type BundlePreview = {
  filename: string;
  path: string;
  files: readonly string[];
  sizeBytes: number;
  appVersion: string;
};

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
