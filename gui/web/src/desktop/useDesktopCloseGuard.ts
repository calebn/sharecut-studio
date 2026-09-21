import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

export type RecordingRole = "host" | "guest";

export function recordingCloseMessage(role: RecordingRole): string {
  if (role === "host") {
    return "Recording is in progress. Closing now will stop the session for everyone and may lose your recording. Close Sharecut Studio anyway?";
  }
  return "Recording is in progress. Closing now will lose your local recording. Close Sharecut Studio anyway?";
}

/**
 * Protects the native window's close button while a local keeper is recording.
 *
 * Tauri requires preventDefault to happen before an async confirmation. The
 * explicit destroy is the only path that permits the close after confirmation.
 * This covers native window close requests; macOS application Quit can bypass
 * Tauri's window event and is documented separately in desktop packaging docs.
 */
export function useDesktopCloseGuard(
  recordingLocally: boolean,
  role: RecordingRole,
): void {
  useEffect(() => {
    if (!recordingLocally || !isTauri()) {
      return;
    }

    const currentWindow = getCurrentWindow();
    let closeConfirmed = false;
    let disposed = false;
    const unlistenPromise = currentWindow.onCloseRequested((event) => {
      event.preventDefault();
      if (closeConfirmed || disposed) {
        return;
      }
      if (!window.confirm(recordingCloseMessage(role))) {
        return;
      }
      closeConfirmed = true;
      void currentWindow.destroy().catch(() => {
        closeConfirmed = false;
      });
    });

    return () => {
      disposed = true;
      void unlistenPromise
        .then((unlisten) => unlisten())
        .catch(() => undefined);
    };
  }, [recordingLocally, role]);
}
