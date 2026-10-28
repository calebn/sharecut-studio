import { useEffect, useEffectEvent, useRef } from "react";

export function useWriteBack<T>(
  value: T,
  onChange?: (value: T) => void,
  latest: T = value,
) {
  const reported = useRef(value);
  const live = useRef(latest);
  const notify = useEffectEvent((next: T) => onChange?.(next));
  useEffect(() => {
    live.current = latest;
  });
  useEffect(() => {
    if (Object.is(reported.current, value)) return;
    reported.current = value;
    notify(value);
  }, [value]);
  useEffect(
    () => () => {
      queueMicrotask(() => {
        if (Object.is(reported.current, live.current)) return;
        reported.current = live.current;
        notify(live.current);
      });
    },
    [],
  );
  return live;
}
