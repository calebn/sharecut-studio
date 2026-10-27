import { useEffect, useEffectEvent, useRef } from "react";

/** Calls `onChange` with each value after the first, so a host can save what a page edits. The first value is what the host gave. */
export function useWriteBack<T>(value: T, onChange?: (value: T) => void) {
  const first = useRef(true);
  const notify = useEffectEvent((next: T) => onChange?.(next));
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    notify(value);
  }, [value]);
}
