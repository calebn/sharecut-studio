import { useEffect, useEffectEvent, useRef } from "react";

export function useWriteBack<T>(value: T, onChange?: (value: T) => void) {
  const reported = useRef(value);
  const notify = useEffectEvent((next: T) => onChange?.(next));
  useEffect(() => {
    if (Object.is(reported.current, value)) return;
    reported.current = value;
    notify(value);
  }, [value]);
}
