export type MicPermissionStatus =
  | "idle"
  | "prompting"
  | "granted"
  | "lost"
  | "denied"
  | "unavailable"
  | "error";

export const MIC_ALLOW_LABEL = "Allow microphone";
export const MIC_RETRY_LABEL = "Retry";
export const MIC_DENIED_COPY =
  "Microphone is blocked for this site. Allow it in your browser's site settings, then Retry.";
export const MIC_DESKTOP_DENIED_COPY =
  "Microphone access is blocked by your operating system. Allow Sharecut Studio in your system microphone privacy settings, then Retry.";
export const MIC_LINUX_DESKTOP_DENIED_COPY =
  "Microphone access is blocked in this Linux desktop window. Retry once, or open Sharecut Studio in your browser and allow microphone access there.";
export const MIC_UNAVAILABLE_COPY =
  "No microphone was found. Connect an input device, then Retry.";
export const MIC_ERROR_COPY = "Couldn't open the microphone. Retry.";
export const MIC_GRANT_HINT_COPY =
  "Allow the microphone before you accept recording.";
export const MIC_PROMPTING_COPY = "Waiting for the browser microphone prompt…";
export const MIC_SAVED_DEVICE_MISSING_COPY =
  "Your saved microphone isn't available, so the default input is in use.";
export const MIC_LOST_COPY = "Microphone disconnected.";
export const MIC_DESKTOP_PROMPTING_COPY =
  "Waiting for the operating system microphone permission prompt…";
export const MIC_LINUX_DESKTOP_PROMPTING_COPY =
  "Waiting for the desktop webview microphone permission prompt…";

/**
 * The desktop shell installs its microphone permission handler only on macOS
 * and Windows. Linux uses WebKitGTK's prompt and has no browser site-settings
 * surface in the desktop window, so it needs its own recovery copy.
 *
 * Keep this scoped to microphone copy. A general Tauri runtime predicate may
 * be shared with the close guard when its dependency lands separately.
 */
function microphonePermissionSurface(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): "native" | "linux-webview" | "browser" {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return "browser";
  }
  if (/(Macintosh|Mac OS X|Windows)/.test(userAgent)) {
    return "native";
  }
  return /Linux/.test(userAgent) ? "linux-webview" : "browser";
}

export function hasNativeMicrophonePermissionHandler(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return microphonePermissionSurface(userAgent) === "native";
}

/** Map a getUserMedia DOMException name to a grant state. */
export function statusFromGumError(
  name: string,
): Extract<MicPermissionStatus, "denied" | "unavailable"> | null {
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "unavailable";
  }
  return null;
}

/** True when a saved (exact) deviceId could not be opened and the default input should be tried. */
export function selectedMicMissing(
  errorName: string | null | undefined,
  deviceId: string,
): boolean {
  return (
    Boolean(deviceId) &&
    (errorName === "OverconstrainedError" || errorName === "NotFoundError")
  );
}

export function micGrantFailed(status: MicPermissionStatus): boolean {
  return (
    status === "denied" ||
    status === "unavailable" ||
    status === "error" ||
    status === "lost"
  );
}

export function copyForMicStatus(status: MicPermissionStatus): string | null {
  if (status === "denied") {
    const surface = microphonePermissionSurface();
    return surface === "native"
      ? MIC_DESKTOP_DENIED_COPY
      : surface === "linux-webview"
        ? MIC_LINUX_DESKTOP_DENIED_COPY
        : MIC_DENIED_COPY;
  }
  if (status === "unavailable") {
    return MIC_UNAVAILABLE_COPY;
  }
  if (status === "error") {
    return MIC_ERROR_COPY;
  }
  if (status === "lost") {
    return MIC_LOST_COPY;
  }
  if (status === "idle") {
    return MIC_GRANT_HINT_COPY;
  }
  if (status === "prompting") {
    const surface = microphonePermissionSurface();
    return surface === "native"
      ? MIC_DESKTOP_PROMPTING_COPY
      : surface === "linux-webview"
        ? MIC_LINUX_DESKTOP_PROMPTING_COPY
        : MIC_PROMPTING_COPY;
  }
  return null;
}

type PermissionQuery = {
  query: (desc: { name: string }) => Promise<{
    state: PermissionState;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  }>;
};

/** Feature-detect `permissions.query({ name: "microphone" })` (Safari lacks it). */
export function microphonePermissionsQuery(): PermissionQuery | null {
  const perms = (navigator as Navigator & { permissions?: PermissionQuery })
    .permissions;
  if (!perms || typeof perms.query !== "function") {
    return null;
  }
  return perms;
}
