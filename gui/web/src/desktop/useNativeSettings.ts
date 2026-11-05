import { useEffect } from "react";

/** The desktop app's native Settings… menu item dispatches this on `window` (gui/desktop/src-tauri/src/settings_menu.rs). */
export const NATIVE_SETTINGS_EVENT = "sharecut:open-settings";

/** Opens Settings when the native menu asks. A browser never dispatches it. */
export function useNativeSettings(open: () => void): void {
  useEffect(() => {
    window.addEventListener(NATIVE_SETTINGS_EVENT, open);
    return () => window.removeEventListener(NATIVE_SETTINGS_EVENT, open);
  }, [open]);
}
