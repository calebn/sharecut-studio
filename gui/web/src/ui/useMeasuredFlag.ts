import { useCallback, useRef, useState } from "react";
import { useResizeObserver } from "./useResizeObserver";

export function useMeasuredFlag<T extends HTMLElement>(
  measure: (element: T) => boolean | null,
) {
  const element = useRef<T | null>(null);
  const [value, setValue] = useState(false);
  const sample = useCallback(
    (node: T) => {
      const next = measure(node);
      if (next !== null) setValue(next);
    },
    [measure],
  );
  const attach = useCallback(
    (node: T | null) => {
      element.current = node;
      if (node) sample(node);
    },
    [sample],
  );
  useResizeObserver(element, (entries) => {
    const node = element.current;
    if (node && entries.some((entry) => entry.target === node)) sample(node);
  });
  return { attach, element, value };
}
