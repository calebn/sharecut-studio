import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

export function useWriteBack<T>(
  initialValue: T,
  onChange?: (value: T) => void,
  paused = false,
) {
  const [value, setValue] = useState(() => initialValue);
  const live = useRef(initialValue);
  const reported = useRef(initialValue);
  const notify = useEffectEvent((next: T) => onChange?.(next));
  const edit = useCallback((change: (current: T) => T) => {
    const next = change(live.current);
    live.current = next;
    setValue(() => next);
  }, []);
  useEffect(() => {
    if (paused || Object.is(reported.current, value)) return;
    reported.current = value;
    notify(value);
  }, [value, paused]);
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
  return [value, edit] as const;
}
