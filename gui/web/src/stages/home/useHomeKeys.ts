import { useEffect, useRef } from "react";
import { isButtonActivation, isTypingTarget } from "../../keymap/typing";
import { overlayOpen } from "../../ui/modalGate";

export type HomeKeyActions = {
  onImport: () => void;
  onRecord: () => void;
  onOpenOther: () => void;
  onPalette: () => void;
};

/** The action a Home key press runs, or null when it is not a Home key. */
export function homeKeyAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
): keyof HomeKeyActions | null {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (event.altKey) return null;
  if (mod) {
    if (key === "i") return "onImport";
    if (key === "o") return "onOpenOther";
    return null;
  }
  if (event.key === "?") return "onPalette";
  if (key === "r") return "onRecord";
  return null;
}

/**
 * Home's keys: Mod+I Import, R Record, Mod+O Open other, ? the command palette. Home is not
 * a project, so the project keymap is not mounted; these hold back for a field,
 * a focused button's own activation and any open menu or dialog.
 */
export function useHomeKeys(actions: HomeKeyActions): void {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (overlayOpen()) return;
      if (isTypingTarget(event.target) || isButtonActivation(event)) return;
      const action = homeKeyAction(event);
      if (!action || event.repeat) return;
      event.preventDefault();
      latest.current[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
