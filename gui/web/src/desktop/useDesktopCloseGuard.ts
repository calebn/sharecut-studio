import { isTauri } from "@tauri-apps/api/core";
import { useLayoutEffect } from "react";

export type RecordingRole = "host" | "guest";

// The native close handler reads this from the current WebView URL. A history
// update stays on the existing loopback page and needs no remote Tauri IPC.
export const CLOSE_GUARD_PARAM = "sc_close_guard";

/**
 * Publishes recording risk for the native Rust close handler without invoking
 * a Tauri plugin from the loopback WebView.
 */
export function useDesktopCloseGuard(
  closeRisk: boolean,
  role: RecordingRole,
  canClear = true,
): void {
  useLayoutEffect(() => {
    if (!isTauri()) {
      return;
    }
    const url = new URL(window.location.href);
    if (closeRisk) {
      url.searchParams.set(CLOSE_GUARD_PARAM, role);
    } else if (canClear) {
      url.searchParams.delete(CLOSE_GUARD_PARAM);
    }
    if (url.href !== window.location.href) {
      window.history.replaceState(window.history.state, "", url);
    }
  }, [closeRisk, role, canClear]);
}
