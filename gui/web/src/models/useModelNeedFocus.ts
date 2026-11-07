import { type RefCallback, useEffect, useRef, useState } from "react";

export function useModelNeedFocus(asking: boolean): RefCallback<HTMLElement> {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const handedOff = useRef(false);
  useEffect(() => {
    if (!asking) {
      handedOff.current = false;
      return;
    }
    const panel = root;
    if (!panel || handedOff.current) return;
    const document = panel.ownerDocument;
    let observer: MutationObserver | null = null;
    const stop = () => {
      observer?.disconnect();
      document.removeEventListener("focusin", moved, true);
      document.removeEventListener("pointerdown", moved, true);
    };
    const moved = () => {
      handedOff.current = true;
      stop();
    };
    const handOff = () => {
      const first = panel.querySelector<HTMLButtonElement>(
        'button:not([aria-label="Manage models"]):not(:disabled)',
      );
      if (!first?.isConnected) return false;
      handedOff.current = true;
      stop();
      first.scrollIntoView?.({ block: "center" });
      first.focus();
      return true;
    };
    if (handOff()) return;
    observer = new MutationObserver(handOff);
    observer.observe(panel, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    document.addEventListener("focusin", moved, true);
    document.addEventListener("pointerdown", moved, true);
    return stop;
  }, [root, asking]);
  return setRoot;
}
