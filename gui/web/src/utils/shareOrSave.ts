export type ExportOutcome =
  | { kind: "shared" }
  | { kind: "downloaded"; filename: string; afterShare: boolean }
  | { kind: "cancelled" };

const FILE_TYPE = "application/zip";
const REVOKE_AFTER_MS = 60_000;

function touchDevice(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches === true;
}

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/**
 * Hands a fetched file to the person: the share sheet where the browser can share a
 * file (a phone or tablet), else a normal download. The caller fetches the file first,
 * because a share needs a recent tap. A share the browser refuses or cannot take falls
 * back to the download, and says so; closing the share sheet is a cancel.
 */
export async function shareOrSave(file: {
  blob: Blob;
  filename: string;
}): Promise<ExportOutcome> {
  const { blob, filename } = file;
  const shareable = new File([blob], filename, { type: FILE_TYPE });
  let afterShare = false;
  if (touchDevice() && navigator.canShare?.({ files: [shareable] })) {
    try {
      await navigator.share({ files: [shareable] });
      return { kind: "shared" };
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError")
        return { kind: "cancelled" };
      afterShare = true;
    }
  }
  save(blob, filename);
  return { kind: "downloaded", filename, afterShare };
}
